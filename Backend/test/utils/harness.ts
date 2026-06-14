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
          for (const m of MODEL_METHODS) delegate[m] = jest.fn();
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
    myIdStatus: 'NOT_STARTED',
    transactionLimitUzs: 1000000,
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
