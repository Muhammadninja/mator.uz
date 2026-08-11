/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Smoke-test harness: a DB-independent Prisma double plus small builders.
 *
 * The Prisma mock is a Proxy that lazily exposes every model delegate with the
 * common methods as `jest.fn()`. `$transaction` runs the callback form against
 * the same proxy (so `tx.x.y` === `prisma.x.y`) and resolves the array form via
 * Promise.all — matching how the services use it. Tests stub only the calls they
 * care about with `.mockResolvedValue(...)`.
 */

import { Global, Module } from '@nestjs/common';
import { DiscountService } from '../../src/sales/discount.service';
import { PaymeFiscalService } from '../../src/orders/webhooks/payme-fiscal.service';
import { QueueService } from '../../src/queue/queue.service';

const MODEL_METHODS = [
  'findUnique',
  'findFirst',
  'findMany',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

/** Delegate methods that resolve to a LIST in the real client. */
const LIST_METHODS = new Set<string>(['findMany', 'groupBy']);

const PASSTHROUGH = new Set(['then', 'catch', 'finally', 'constructor', 'prototype', 'toJSON']);

export type PrismaMock = any;

export function createPrismaMock(): PrismaMock {
  const cache: Record<string, any> = {};
  const proxy: any = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (PASSTHROUGH.has(prop)) return undefined;
        if (prop === '$transaction') {
          return (cache.$transaction ??= jest.fn(async (arg: any) =>
            typeof arg === 'function' ? arg(proxy) : Promise.all(arg),
          ));
        }
        if (prop.startsWith('$') || prop.startsWith('onModule') || prop === 'enableShutdownHooks') {
          return (cache[prop] ??= jest.fn());
        }
        if (!cache[prop]) {
          const delegate: any = {};
          // Defaults match PRISMA'S CONTRACT rather than being bare jest.fn()
          // (which resolves to `undefined`). A list method always returns an
          // array and `count` a number, so a query a test did not explicitly
          // stub behaves like "no rows" instead of crashing the caller on
          // `undefined.map(...)`. That failure mode is what breaks a suite
          // whenever production adds a query — the test is then failing on the
          // mock's shape, not on the behaviour it means to assert. Any test
          // needing real rows still overrides with `.mockResolvedValue(...)`.
          for (const m of MODEL_METHODS) {
            delegate[m] = LIST_METHODS.has(m)
              ? jest.fn().mockResolvedValue([])
              : m === 'count'
                ? jest.fn().mockResolvedValue(0)
                : jest.fn();
          }
          cache[prop] = delegate;
        }
        return cache[prop];
      },
    },
  );
  return proxy;
}

/** Minimal ConfigService double backed by a plain map. */
export function fakeConfig(map: Record<string, string | undefined> = {}): any {
  return { get: (key: string) => map[key] };
}

/**
 * In-memory RedisService double: a Map with TTL bookkeeping. TTLs are recorded
 * (readable via `ttls`) but not auto-expired — tests drive expiry explicitly by
 * clearing the key. `exists` is a single lookup, mirroring the real one-EXISTS
 * blacklist check. `store`/`ttls` are exposed for assertions.
 */
export function fakeRedis(): any {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    setEx: jest.fn(async (key: string, ttl: number, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
      ttls.set(key, ttl);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.delete(key) ? 1 : 0;
      ttls.delete(key);
      return existed;
    }),
    exists: jest.fn(async (key: string) => store.has(key)),
    expire: jest.fn(async (key: string, ttl: number) => {
      if (!store.has(key)) return false;
      ttls.set(key, ttl);
      return true;
    }),
    ttl: jest.fn(async (key: string) => ttls.get(key) ?? -2),
    incr: jest.fn(async (key: string) => {
      const next = ((store.get(key) as number) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
  };
}

// Minimal stand-ins for the side-effect collaborators OrdersService now takes.
export function fakeNotifications(): any {
  return { emit: jest.fn().mockResolvedValue(undefined) };
}
export function fakeRealtime(): any {
  return { emit: jest.fn() };
}

/**
 * A QueueService double.
 *
 * OTP delivery and notification push fan-out are ENQUEUED, not executed on the
 * request path: OtpService takes a QueueService (not SmsService) and calls
 * `enqueueSms`, and NotificationsService calls `enqueueNotification` after
 * committing the inbox row. So the observable behaviour a test asserts is "a job
 * was enqueued with this payload/jobId", which is what this records.
 *
 * The two jobId helpers reproduce the REAL deterministic formats rather than
 * returning a stub, because their whole purpose is idempotency (the same issue
 * enqueued twice must collapse to one job) — a test asserting on a job id must
 * see the id production would actually use.
 */
export function fakeQueue(): any {
  return {
    enqueueSms: jest.fn(async (data: unknown, opts?: unknown) => ({
      id: (opts as any)?.jobId ?? 'sms_auto',
      data,
    })),
    otpSmsJobId: jest.fn(
      (requestId: string, sendCount: number) =>
        `sms_otp_${requestId}_${sendCount}`,
    ),
    enqueueNotification: jest.fn(async (data: any) => ({
      id: `notify_${data?.notificationId}`,
      data,
    })),
    notificationJobId: jest.fn(
      (data: any) => `notify_${data?.notificationId}`,
    ),
    enqueueImage: jest.fn(async () => ({ id: 'image_auto' })),
    reenqueueImage: jest.fn(async () => ({ id: 'image_auto' })),
    removeImageJob: jest.fn(async () => undefined),
  };
}

/**
 * A `@Global` module supplying the QueueService token, for DI-boot suites.
 *
 * QueueModule became `@Global` and is supplied by AppModule in production —
 * the same situation PrismaModule and RedisModule are already handled for in
 * these suites. Standalone testing modules must put it in the graph themselves,
 * or every service that injects QueueService (OtpService, NotificationsService)
 * fails to resolve.
 *
 * The REAL QueueModule is deliberately not imported: it registers four BullMQ
 * queues and the whole processor/worker stack, which would open Redis
 * connections a DI-graph check neither needs nor has. This provides just the
 * injectable, so the graph resolves exactly as production while nothing
 * connects.
 */
@Global()
@Module({
  providers: [{ provide: QueueService, useFactory: fakeQueue }],
  exports: [QueueService],
})
export class FakeQueueModule {}

/**
 * A DiscountService that prices everything at full price — the "no active sale"
 * baseline these smoke tests were written against, so their expected totals are
 * unaffected by the sales feature.
 *
 * `loadActiveSales` is stubbed to return no sales rather than the whole service
 * being faked, so the REAL `calculateDiscount*` arithmetic still runs: if that
 * logic ever mis-handles the empty-sales case, these tests notice.
 */
export function fakeDiscounts(): any {
  const svc = new DiscountService(createPrismaMock() as any);
  jest.spyOn(svc, 'loadActiveSales').mockResolvedValue([]);
  return svc;
}

/**
 * The REAL fiscal-receipt builder over the Prisma double.
 *
 * Deliberately not a stub: with no `order_items` stubbed the mock reports an
 * order with no product lines, so `buildOrderDetail` returns null and both the
 * checkout gate and CheckPerformTransaction behave exactly as they did before
 * fiscalization existed. A test that wants a receipt stubs `orderItem.findMany`
 * / `catalogPart.findMany` and gets the production mapping, not a fake one.
 *
 * `env` supplies the platform's own fiscal codes (delivery, service fee) for a
 * test that builds a receipt containing them; delivery falls back to the same
 * defaults production uses.
 */
export function fakeFiscal(
  prisma: PrismaMock,
  env: Record<string, string | undefined> = {},
): any {
  return new PaymeFiscalService(prisma, fakeConfig(env));
}

let seq = 0;
const uid = (p: string) => `${p}_${(seq++).toString(36).padStart(6, '0')}`;

// ── entity builders (only the fields the code/presenters read) ────────────────
export function buildAppUser(over: Partial<any> = {}): any {
  return {
    id: over.id ?? uid('usr'),
    email: null,
    passwordHash: null,
    phoneE164: null,
    phoneVerified: false,
    emailVerified: false,
    displayName: null,
    avatarUrl: null,
    firstName: null,
    lastName: null,
    role: 'USER',
    language: 'UZ',
    myIdStatus: 'NOT_STARTED',
    transactionLimitUzs: 1000000,
    tokenVersion: 0,
    thumbnailUrl: null,
    // Account deletion (DELETE /v1/me): a live account has neither set. A test
    // for a deleted account overrides `deletedAt`.
    avatarPublicId: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

export function buildVehicle(over: Partial<any> = {}): any {
  return {
    id: over.id ?? uid('veh'),
    userId: over.userId ?? uid('usr'),
    isPrimary: true,
    nickname: 'Mening moshinam',
    makeId: 'make_chevrolet',
    modelId: 'model_cobalt',
    year: 2022,
    trimId: 'trim_lt',
    engineId: 'engine_b15d2',
    transmission: 'AUTOMATIC',
    drivetrain: 'FWD',
    colorHex: '#101114',
    vin: null,
    licensePlate: '01A777AA',
    registrationRegionCode: '01',
    mileageKm: 42000,
    fuelType: 'PETROL',
    model3dAssetId: null,
    deletedAt: null,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    make: { id: 'make_chevrolet', name: 'Chevrolet', logoUrl: null },
    model: { id: 'model_cobalt', name: 'Cobalt' },
    trim: { id: 'trim_lt', name: 'LT' },
    engine: { id: 'engine_b15d2', name: 'B15D2', displacementCc: 1485, fuelType: 'PETROL' },
    model3dAsset: null,
    ...over,
  };
}

export function buildCart(over: Partial<any> = {}): any {
  return {
    id: over.id ?? uid('cart'),
    userId: over.userId ?? uid('usr'),
    promoCode: null,
    promoDiscountUzs: null,
    items: [],
    ...over,
  };
}

export function buildCartItem(over: Partial<any> = {}): any {
  return {
    id: over.id ?? uid('item'),
    cartId: over.cartId ?? uid('cart'),
    partId: 'part_belt',
    serviceId: null,
    providerId: null,
    vehicleId: null,
    title: 'Timing belt',
    imageUrl: null,
    priceUzsSnapshot: 185000,
    quantity: 1,
    scheduledAt: null,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    ...over,
  };
}

export function buildOrder(over: Partial<any> = {}): any {
  return {
    id: over.id ?? uid('ord'),
    userId: over.userId ?? uid('usr'),
    status: 'PENDING_PAYMENT',
    subtotalUzs: 185000,
    deliveryUzs: 25000,
    serviceFeeUzs: 5000,
    discountUzs: 0,
    totalUzs: 215000,
    currency: 'UZS',
    vehicleId: null,
    deliveryAddressId: null,
    deliveryMethod: 'COURIER',
    contactPhoneE164: '+998901234567',
    promoCode: null,
    expiresAt: new Date('2026-03-01T01:00:00Z'),
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    items: [],
    ...over,
  };
}
