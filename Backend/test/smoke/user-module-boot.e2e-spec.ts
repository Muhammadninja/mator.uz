import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { UserModule } from '../../src/user/user.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CloudinaryService } from '../../src/cloudinary/cloudinary.service';
import { UserController } from '../../src/user/user.controller';
import { createPrismaMock } from '../utils/harness';

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
      imports: [ConfigModule.forRoot({ isGlobal: true }), UserModule],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      .overrideProvider(CloudinaryService)
      .useValue({ uploadBuffer: jest.fn() })
      .compile();
  });

  afterAll(async () => {
    await mod?.close();
  });

  it('resolves the UserController with all its service dependencies', () => {
    expect(mod.get(UserController)).toBeInstanceOf(UserController);
  });
});
