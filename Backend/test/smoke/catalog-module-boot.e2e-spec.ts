/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { TokenService } from '../../src/auth/tokens/token.service';
import {
  buildAppUser,
  createPrismaMock,
  fakeRedis,
  FakeQueueModule,
  PrismaMock,
} from '../utils/harness';

/**
 * DI-graph boot + HTTP check for CatalogModule after it started importing
 * AuthModule (the passport JWT strategy behind the OptionalJwtAuthGuard on
 * POST /v1/catalog/parts/:id/check-compatibility). Prisma and Redis are
 * mocked — no DB. Proves, through the real guard + controller + service:
 *   • the module graph resolves;
 *   • an anonymous call still answers (no vehicle lookup at all);
 *   • with a real bearer token the vehicle is looked up ONLY in that user's
 *     garage, and a curated Fitment Studio binding to its model answers
 *     EXACT_MATCH.
 */
describe('CatalogModule boot + check-compatibility over HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let token: string;
  const USER = buildAppUser({ id: 'usr_owner', tokenVersion: 0 });

  beforeAll(async () => {
    prisma = createPrismaMock();
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        RedisModule,
        // QueueModule is @Global in production; supply the token here.
        FakeQueueModule,
        CatalogModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma.refreshToken.create.mockResolvedValue({ id: 'rt_1' });
    token = (
      await app.get(TokenService).issueSession({
        id: USER.id,
        email: USER.email,
        role: USER.role,
        tokenVersion: 0,
      })
    ).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    prisma.catalogPart.findUnique.mockResolvedValue({
      id: 'part_1',
      isUniversal: false,
      oemNumbers: ['96985730'],
      compatibilities: [],
      fitmentBindings: [{ vehicleModelId: 'cobalt' }],
    });
    prisma.appUser.findUnique.mockResolvedValue(USER);
    prisma.vehicle.findFirst.mockReset();
  });

  it('an anonymous caller is answered without any vehicle lookup', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/catalog/parts/part_1/check-compatibility')
      .send({ vin: 'XWBLB69V6M0000123' })
      .expect(200);
    expect(res.body.status).toBe('UNCERTAIN');
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
  });

  it("with a token: the caller's own Cobalt + a curated Cobalt binding → EXACT_MATCH", async () => {
    prisma.vehicle.findFirst.mockResolvedValue({
      modelId: 'cobalt',
      trimId: null,
      engineId: null,
      year: 2022,
      make: { name: 'Chevrolet' },
      model: { name: 'Cobalt' },
    });
    const res = await request(app.getHttpServer())
      .post('/v1/catalog/parts/part_1/check-compatibility')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 'veh_1' })
      .expect(200);
    expect(res.body.status).toBe('EXACT_MATCH');
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'veh_1', userId: USER.id, deletedAt: null },
      }),
    );
  });

  it("with a token: someone else's VIN does not resolve → UNCERTAIN", async () => {
    prisma.vehicle.findFirst.mockResolvedValue(null);
    const res = await request(app.getHttpServer())
      .post('/v1/catalog/parts/part_1/check-compatibility')
      .set('Authorization', `Bearer ${token}`)
      .send({ vin: 'XWBOTHERUSER00001' })
      .expect(200);
    expect(res.body.status).toBe('UNCERTAIN');
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vin: 'XWBOTHERUSER00001', userId: USER.id, deletedAt: null },
      }),
    );
  });

  it('an invalid token is treated as anonymous, never rejected', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/catalog/parts/part_1/check-compatibility')
      .set('Authorization', 'Bearer not-a-jwt')
      .send({ vehicleId: 'veh_1' })
      .expect(200);
    expect(res.body.status).toBe('UNCERTAIN');
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
  });
});
