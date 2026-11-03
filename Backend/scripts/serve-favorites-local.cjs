/* LOCAL-ONLY synthetic fixtures. Fixed loopback database/Redis/listener; no .env. */
require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { PassportModule } = require('@nestjs/passport');
const {
  ValidationPipe,
  UnauthorizedException,
  Controller,
  Get,
  Request,
  UseGuards,
} = require('@nestjs/common');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const load = (path) => require(`../dist/src/${path}`);
const { FavoritesController } = load('user/favorites/favorites.controller');
const { FavoritesService } = load('user/favorites/favorites.service');
const { PrismaService } = load('prisma/prisma.service');
const { JwtStrategy } = load('auth/strategies/jwt.strategy');
const { JwtAuthGuard } = load('auth/guards/jwt-auth.guard');
const { JwtKeyService } = load('auth/tokens/jwt-key.service');
const { TokenService } = load('auth/tokens/token.service');
const { RedisService } = load('redis/redis.service');
const { AuthController } = load('auth/auth.controller');
const { AuthService } = load('auth/auth.service');
const { PhoneAuthService } = load('auth/phone/phone-auth.service');
const { PartsController } = load('catalog/parts/parts.controller');
const { PartsService } = load('catalog/parts/parts.service');
const { DiscountService } = load('sales/discount.service');
const { presentMe } = load('user/user.presenter');
const fixturePath = '/tmp/mator-favorites-http-fixture.json';
const prisma = new PrismaClient({
  datasourceUrl:
    'postgresql://mator_local@127.0.0.1:55432/mator_favorites_validation_v3?schema=public',
});
const prefix = `fav_native_${Date.now()}`;
const redisClient = new Redis({
  host: '127.0.0.1',
  port: 56379,
  db: 14,
  keyPrefix: `${prefix}:`,
  maxRetriesPerRequest: 1,
});
const redis = new RedisService(redisClient);
const users = [0, 1].map((i) => ({
  id: randomUUID(),
  phoneE164: `+99890000010${i + 1}`,
  phoneVerified: true,
  displayName: `Local Favorites ${i + 1}`,
}));
const partIds = [0, 1, 2].map((i) => `${prefix}_${i}`);
const requests = new Map();
let app;
class LocalProfileController {
  async me(req) {
    const user = await prisma.appUser.findUnique({
      where: { id: req.user.id },
    });
    return presentMe(user, null);
  }
}
Controller('v1/me')(LocalProfileController);
UseGuards(JwtAuthGuard)(LocalProfileController);
Get()(
  LocalProfileController.prototype,
  'me',
  Object.getOwnPropertyDescriptor(LocalProfileController.prototype, 'me'),
);
Request()(LocalProfileController.prototype, 'me', 0);
class LocalLegalController {
  status() {
    return {
      requires_acceptance: false,
      documents: [
        'TERMS_OF_USE',
        'PRIVACY_POLICY',
        'PERSONAL_DATA_CONSENT',
      ].map((type) => ({
        type,
        required_version: 1,
        accepted_version: 1,
        accepted: true,
        accepted_at: '2026-01-01T00:00:00.000Z',
      })),
    };
  }
}
Controller('v1/legal')(LocalLegalController);
UseGuards(JwtAuthGuard)(LocalLegalController);
Get('status')(
  LocalLegalController.prototype,
  'status',
  Object.getOwnPropertyDescriptor(LocalLegalController.prototype, 'status'),
);
const fixtureDocs = [
  'TERMS_OF_USE',
  'PRIVACY_POLICY',
  'PERSONAL_DATA_CONSENT',
].map((type) => ({
  type,
  version: 1,
  locale: 'ru',
  title: `LOCAL TEST ONLY — ${type}`,
  content:
    '# Только локальная проверка\n\nСинтетический документ для проверки интерфейса. Не является юридическими условиями и не фиксирует согласие.',
  content_format: 'markdown',
  effective_at: '2026-01-01T00:00:00.000Z',
  is_required: true,
}));
class LocalLegalDocumentsController {
  documents() {
    return { documents: fixtureDocs };
  }
  document(req) {
    return fixtureDocs.find(
      (doc) =>
        doc.type === req.params.type &&
        String(doc.version) === req.params.version,
    );
  }
}
Controller('v1/legal/documents')(LocalLegalDocumentsController);
Get()(
  LocalLegalDocumentsController.prototype,
  'documents',
  Object.getOwnPropertyDescriptor(
    LocalLegalDocumentsController.prototype,
    'documents',
  ),
);
Get(':type/:version')(
  LocalLegalDocumentsController.prototype,
  'document',
  Object.getOwnPropertyDescriptor(
    LocalLegalDocumentsController.prototype,
    'document',
  ),
);
Request()(LocalLegalDocumentsController.prototype, 'document', 0);
async function main() {
  await prisma.appUser.createMany({ data: users });
  await prisma.partCategory.create({
    data: {
      id: prefix,
      name: 'Local fixtures',
      nameRu: 'Локальные товары',
      nameUz: 'Mahalliy mahsulotlar',
      nameEn: 'Local fixtures',
    },
  });
  await prisma.catalogSeller.create({
    data: { id: prefix, name: 'LOCAL TEST ONLY' },
  });
  await prisma.catalogPart.createMany({
    data: partIds.map((id, i) => ({
      id,
      title: `LOCAL TEST ONLY ${i + 1}`,
      sellerId: prefix,
      categoryId: prefix,
      priceUzs: 10000 + i * 1000,
      stockQty: 10,
      images: ['https://example.invalid/local-only.png'],
      oemNumbers: [],
      gmNumbers: [],
    })),
  });
  const config = new ConfigService({
    NODE_ENV: 'test',
    JWT_AUDIENCE: 'mator-local-favorites',
  });
  const keys = new JwtKeyService(config);
  const tokens = new TokenService(
    prisma,
    new JwtService(),
    keys,
    config,
    redis,
  );
  const phone = {
    async checkAvailability(dto) {
      return {
        phone_e164: dto.phone_e164,
        is_existing_user: users.some((u) => u.phoneE164 === dto.phone_e164),
      };
    },
    async requestOtp(dto) {
      if (!users.some((u) => u.phoneE164 === dto.phone_e164))
        throw new UnauthorizedException('Synthetic accounts only');
      const request_id = randomUUID();
      requests.set(request_id, dto.phone_e164);
      return {
        request_id,
        phone_e164: dto.phone_e164,
        expires_at: new Date(Date.now() + 300000).toISOString(),
        resend_after_seconds: 1,
        otp_length: 6,
        delivery_channel: 'sms',
        is_existing_user: true,
        next_screen: 'AuthOtpVerifyScreen',
        dev_otp_code: '123456',
      };
    },
    async verifyOtp(dto) {
      if (
        requests.get(dto.request_id) !== dto.phone_e164 ||
        dto.otp_code !== '123456'
      )
        throw new UnauthorizedException();
      requests.delete(dto.request_id);
      const user = await prisma.appUser.findUnique({
        where: { phoneE164: dto.phone_e164 },
      });
      const session = await tokens.issueSession(user);
      return {
        user: {
          id: user.id,
          phone_e164: user.phoneE164,
          display_name: user.displayName,
          avatar_url: null,
          myid_status: 'not_started',
          transaction_limit_uzs: 0,
          created_at: user.createdAt.toISOString(),
        },
        tokens: {
          access_token: session.accessToken,
          access_token_expires_at: session.accessTokenExpiresAt.toISOString(),
          refresh_token: session.refreshToken,
          refresh_token_expires_at: session.refreshTokenExpiresAt.toISOString(),
          token_type: 'Bearer',
        },
        device_binding: { device_id: null, expo_push_token_registered: false },
        next_screen: 'GarageListScreen',
      };
    },
  };
  const module = await Test.createTestingModule({
    imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
    controllers: [
      FavoritesController,
      AuthController,
      PartsController,
      LocalProfileController,
      LocalLegalController,
      LocalLegalDocumentsController,
    ],
    providers: [
      FavoritesService,
      PartsService,
      DiscountService,
      JwtStrategy,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
      { provide: JwtKeyService, useValue: keys },
      { provide: TokenService, useValue: tokens },
      { provide: RedisService, useValue: redis },
      { provide: AuthService, useValue: { getMe: (user) => user } },
      { provide: PhoneAuthService, useValue: phone },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableCors();
  app.use((req, res, next) => {
    res.on('finish', () =>
      console.log(`${req.method} ${req.path} ${res.statusCode}`),
    );
    next();
  });
  await app.listen(3304, '127.0.0.1');
  const accounts = [];
  for (const seed of users) {
    const user = await prisma.appUser.findUnique({ where: { id: seed.id } });
    const session = await tokens.issueSession(user);
    accounts.push({
      disposable: true,
      ...seed,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });
  }
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      kind: 'mator-favorites-disposable-http-v1',
      baseUrl: 'http://127.0.0.1:3304',
      accounts,
      partIds,
      otpCode: '123456',
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(fixturePath, 0o600);
  console.log(
    `Local favorites server ready on127.0.0.1:3304; protected fixture ${fixturePath}; realRS256 JWT, local PostgreSQL and Redis14. Synthetic OTP123456 for +998900000101/+998900000102 only.`,
  );
}
let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  // Delete only this run's namespaced Redis keys; never FLUSHDB/shared data.
  const namespacedKeys = await redisClient.keys(`${prefix}:*`);
  if (namespacedKeys.length) {
    const raw = new Redis({
      host: '127.0.0.1',
      port: 56379,
      db: 14,
      maxRetriesPerRequest: 1,
    });
    await raw.del(...namespacedKeys);
    await raw.quit();
  }
  if (app) await app.close();
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: users.map((u) => u.id) } },
  });
  await prisma.appUser.deleteMany({
    where: { id: { in: users.map((u) => u.id) } },
  });
  await prisma.catalogPart.deleteMany({ where: { id: { in: partIds } } });
  await prisma.catalogSeller.deleteMany({ where: { id: prefix } });
  await prisma.partCategory.deleteMany({ where: { id: prefix } });
  await prisma.$disconnect();
  if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
  process.exit(exitCode);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
main().catch(async (e) => {
  console.error(e);
  await stop(1);
});
