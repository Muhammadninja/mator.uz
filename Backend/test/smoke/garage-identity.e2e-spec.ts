/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- the Prisma harness (test/utils/harness.ts) and supertest bodies are untyped by design */
/**
 * POST /v1/garage/vehicles over HTTP (real controller, ValidationPipe as in
 * main.ts, HttpExceptionFilter): the Brand → Model → Year body resolves and
 * returns the vehicle identity and image, and an unsupported year is refused
 * with a stable code. The pipeline integration is off; nothing is queued.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { VehiclesController } from '../../src/garage/vehicles/vehicles.controller';
import { VehiclesService } from '../../src/garage/vehicles/vehicles.service';
import { VehicleImagesService } from '../../src/garage/vehicle-images/vehicle-images.service';
import { VehicleImageDeliveryService } from '../../src/garage/vehicle-images/vehicle-image.delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QUEUE_NAMES } from '../../src/queue/queue.constants';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createPrismaMock, PrismaMock } from '../utils/harness';

const ref = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  makeId: 'chevrolet',
  name,
  bodyType: null,
  yearFrom: null,
  yearTo: null,
  ...over,
});
const N100 = ref('nexia-1', 'Nexia 1', { yearFrom: 1996, yearTo: 2008 });
const N150 = ref('nexia-2', 'Nexia 2', { yearFrom: 2008, yearTo: 2016 });
const R3 = ref('nexia-3', 'Nexia 3', {
  yearFrom: 2016,
  yearTo: 2022,
  bodyType: 'Sedan',
});
const MODELS: Record<string, any> = {
  cobalt: { ...ref('cobalt', 'Cobalt', { bodyType: 'Sedan' }), variants: [] },
  spark: { ...ref('spark', 'Spark'), variants: [] },
  nexia: { ...ref('nexia', 'Nexia'), variants: [N100, N150, R3] },
};

describe('Garage identity over HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let identities: Map<string, any>;
  const queue = { add: jest.fn() };

  beforeAll(async () => {
    prisma = createPrismaMock();
    const mod = await Test.createTestingModule({
      controllers: [VehiclesController],
      providers: [
        VehiclesService,
        VehicleImagesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: VehicleImageDeliveryService,
          useValue: { enabled: false, refresh: jest.fn() },
        },
        { provide: getQueueToken(QUEUE_NAMES.VEHICLE_IMAGES), useValue: queue },
        { provide: RealtimeGateway, useValue: { emitGarageEvent: jest.fn() } },
        { provide: NotificationsService, useValue: { emit: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { id: 'usr_1' };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    identities = new Map();
    queue.add.mockReset();
    prisma.vehicleModelRef.findUnique.mockImplementation(
      async ({ where }: any) => MODELS[where.id] ?? null,
    );
    prisma.vehicleModelRef.findMany.mockResolvedValue([
      { name: 'Gentra' },
      { name: 'Malibu' },
    ]);
    prisma.vehicleMake.findUnique.mockResolvedValue({
      id: 'chevrolet',
      name: 'Chevrolet',
    });
    prisma.vehicle.count.mockResolvedValue(0);
    prisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
    prisma.vehicle.create.mockReset();
    prisma.vehicleImageIdentity.createMany.mockImplementation(
      async ({ data }: any) => {
        for (const d of data)
          if (!identities.has(d.identityKey)) identities.set(d.identityKey, d);
        return { count: 1 };
      },
    );
    prisma.vehicleImageIdentity.update.mockImplementation(
      async ({ where, data }: any) =>
        Object.assign(identities.get(where.identityKey), data),
    );
    prisma.vehicle.create.mockImplementation(async ({ data }: any) => ({
      trimId: null,
      variantModelId: null,
      ...data,
      createdAt: new Date('2026-11-13T00:00:00Z'),
      updatedAt: new Date('2026-11-13T00:00:00Z'),
      make: { id: 'chevrolet', name: 'Chevrolet', logoUrl: null },
      model: MODELS[data.modelId],
      trim: null,
      engine: null,
      model3dAsset: null,
      imageIdentity: data.imageIdentityKey
        ? identities.get(data.imageIdentityKey)
        : null,
    }));
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/v1/garage/vehicles').send(body);

  it('Cobalt 2020 → 201 with the saved identity and the approved Cobalt image', async () => {
    const res = await post({
      make_id: 'chevrolet',
      model_id: 'cobalt',
      year: 2020,
    });
    expect(res.status).toBe(201);
    expect(res.body.model).toEqual({ id: 'cobalt', name: 'Cobalt' });
    expect(res.body.year).toBe(2020);
    expect(res.body.identity).toEqual({
      status: 'verified',
      reason: null,
      model_id: 'cobalt',
      generation_id: 'cobalt-gen2',
      facelift_id: null,
      market: 'UZ',
      year_basis: 'production',
    });
    expect(res.body.vehicle_image).toEqual({
      status: 'approved',
      url: null,
      version: 1,
      catalog_asset_key: 'cobalt-gen2',
      reason: null,
    });
    const saved = prisma.vehicle.create.mock.calls[0][0].data;
    expect(saved).toMatchObject({
      makeId: 'chevrolet',
      modelId: 'cobalt',
      year: 2020,
      identityModelId: 'cobalt',
      identityGenerationId: 'cobalt-gen2',
      identityMarket: 'UZ',
      imageReviewReason: null,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('Nexia 2023 → 400 VEHICLE_YEAR_UNSUPPORTED with the supported range; nothing saved', async () => {
    const res = await post({
      make_id: 'chevrolet',
      model_id: 'nexia',
      year: 2023,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: 'VEHICLE_YEAR_UNSUPPORTED',
      message: 'Nexia is not available for 2023.',
      details: { year: 2023, year_from: 1996, year_to: 2022 },
    });
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it('Spark 2020 → 201, an unverified identity (no market guessed), no image guessed', async () => {
    const res = await post({
      make_id: 'chevrolet',
      model_id: 'spark',
      year: 2020,
    });
    expect(res.status).toBe(201);
    expect(res.body.identity).toMatchObject({
      status: 'unverified',
      reason: null,
      model_id: 'spark',
      generation_id: null,
      market: null,
    });
    // Pipeline integration off here: saved for later, nothing requested, no image.
    expect(res.body.vehicle_image).toEqual({
      status: 'unavailable',
      url: null,
      version: null,
      reason: 'not_requested',
    });
    expect(identities.size).toBe(1);
    const [stored] = [...identities.values()];
    expect(stored.identity).toMatchObject({ modelId: 'spark', identityStatus: 'unverified' });
    expect(stored.identity).not.toHaveProperty('marketRegion');
  });

  it('a client cannot state the market or generation itself', async () => {
    for (const extra of [{ market: 'US' }, { generation_id: 'cobalt-gen2' }]) {
      const res = await post({
        make_id: 'chevrolet',
        model_id: 'cobalt',
        year: 2020,
        ...extra,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });
});
