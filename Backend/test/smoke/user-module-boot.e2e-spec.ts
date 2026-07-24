import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { UserModule } from '../../src/user/user.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CloudinaryService } from '../../src/cloudinary/cloudinary.service';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { UserController } from '../../src/user/user.controller';
import { fakeRedis, createPrismaMock } from '../utils/harness';

/**
 * DI-graph boot check for UserModule. Proves the full injection graph resolves
 * with Prisma + Cloudinary mocked (no DB, no real upload): AvatarService gets
 * CloudinaryService (global module, imported explicitly), PhoneChangeService
 * gets OtpService + TokenService (exported from AuthModule), and UserService
 * gets AddressesService (exported from AddressesModule). Regression guard for
 * the change-phone / avatar / address wiring.
 */
describe('UserModule boot (e2e)', () => {
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        RedisModule,
        UserModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      .overrideProvider(CloudinaryService)
      .useValue({ uploadBuffer: jest.fn() })
      // RedisModule is @Global; a standalone testing module must put it in the
      // graph itself (like PrismaModule elsewhere), with RedisService swapped for
      // the in-memory double since there is no live Redis here.
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .compile();
  });

  afterAll(async () => {
    await mod?.close();
  });

  it('resolves the UserController with all its service dependencies', () => {
    expect(mod.get(UserController)).toBeInstanceOf(UserController);
  });
});
