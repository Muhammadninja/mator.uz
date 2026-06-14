import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { CartModule } from './../src/cart/cart.module';
import { RealtimeModule } from './../src/realtime/realtime.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { createPrismaMock } from './utils/harness';

/**
 * HTTP integration boot: stands up real contract controllers + the JWT guard
 * pipeline + the native WS adapter, with Prisma mocked (no DB). Verifies the
 * app initializes end-to-end and that protected routes enforce auth. The legacy
 * Telegram/AI modules are intentionally excluded (they launch a polling bot on
 * boot), so the full AppModule is not used here.
 */
describe('App integration boot (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), CartModule, RealtimeModule],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      .compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots the DI graph including the realtime gateway + WS adapter', () => {
    expect(app).toBeDefined();
  });

  it('rejects an unauthenticated request to a protected route (401)', () => {
    return request(app.getHttpServer()).get('/v1/cart').expect(401);
  });
});
