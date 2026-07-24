import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RealtimeModule } from '../../src/realtime/realtime.module';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { TokenService } from '../../src/auth/tokens/token.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { fakeRedis, createPrismaMock } from '../utils/harness';

/**
 * DI-graph boot check for RealtimeModule. The gateway now injects TokenService
 * so it can subscribe to session revocations and drop live sockets; this proves
 * that resolves (TokenService is exported by AuthModule, which RealtimeModule
 * already imports) and that the dependency stays one-way — AuthModule must not
 * need to know the realtime transport exists, or the two modules would form a
 * cycle. Also asserts the gateway actually subscribed during onModuleInit.
 */
describe('RealtimeModule boot (e2e)', () => {
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      // PrismaModule is @Global and supplied by AppModule in production (the
      // same way AuthModule gets it); a standalone testing module must put it
      // in the graph itself before PrismaService can be overridden.
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        RealtimeModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      // RedisModule is @Global and its graph needs the real Redis client; a
      // standalone testing module has no live Redis, so swap RedisService for the
      // in-memory double (same pattern as PrismaService above).
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .compile();
    await mod.init(); // fires onModuleInit
  });

  afterAll(async () => {
    await mod?.close();
  });

  it('resolves the gateway with its auth dependencies', () => {
    expect(mod.get(RealtimeGateway)).toBeInstanceOf(RealtimeGateway);
  });

  it('registers the gateway as a session-revocation listener', () => {
    const tokens = mod.get(TokenService);
    const gateway = mod.get(RealtimeGateway);
    const disconnect = jest.spyOn(gateway, 'disconnectUser').mockReturnValue(0);

    tokens.notifySessionsRevoked('usr_1');
    expect(disconnect).toHaveBeenCalledWith('usr_1');
  });
});
