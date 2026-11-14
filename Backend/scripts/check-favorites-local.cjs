/* Dedicated disposable local database only. Never loads app configuration/.env. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { PrismaClient } = require('@prisma/client');
const {
  FavoritesController,
} = require('../dist/src/user/favorites/favorites.controller');
const {
  FavoritesService,
} = require('../dist/src/user/favorites/favorites.service');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { JwtAuthGuard } = require('../dist/src/auth/guards/jwt-auth.guard');
const {
  AccountDeletionService,
} = require('../dist/src/user/account-deletion.service');
const prisma = new PrismaClient({
  datasourceUrl:
    'postgresql://mator_local@127.0.0.1:55432/mator_favorites_validation_v3?schema=public',
});
const users = [randomUUID(), randomUUID()];
const prefix = `fav_${Date.now()}`;
const parts = [0, 1, 2, 3].map((i) => `${prefix}_${i}`);
const hidden = ['seller', 'photo', 'price'].map((kind) => `${prefix}_${kind}`);
let app;
let checks = 0;
async function main() {
  await prisma.appUser.createMany({ data: users.map((id) => ({ id })) });
  await prisma.partCategory.create({
    data: {
      id: prefix,
      name: 'Local',
      nameRu: 'Local',
      nameUz: 'Local',
      nameEn: 'Local',
    },
  });
  await prisma.catalogSeller.create({ data: { id: prefix, name: 'Local' } });
  await prisma.catalogPart.createMany({
    data: parts.map((id) => ({
      id,
      title: 'Local validation only',
      sellerId: prefix,
      categoryId: prefix,
      priceUzs: 100,
      images: ['https://example.invalid/local.jpg'],
      oemNumbers: [],
      gmNumbers: [],
    })),
  });
  await prisma.catalogSeller.create({
    data: { id: `${prefix}_hidden`, name: 'Hidden local', status: 'SUSPENDED' },
  });
  await prisma.catalogPart.createMany({
    data: hidden.map((id, i) => ({
      id,
      title: 'Hidden local validation',
      sellerId: i === 0 ? `${prefix}_hidden` : prefix,
      categoryId: prefix,
      priceUzs: i === 2 ? 0 : 100,
      images: i === 1 ? [] : ['https://example.invalid/local.jpg'],
      oemNumbers: [],
      gmNumbers: [],
    })),
  });
  const module = await Test.createTestingModule({
    controllers: [FavoritesController],
    providers: [FavoritesService, { provide: PrismaService, useValue: prisma }],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate(context) {
        const req = context.switchToHttp().getRequest();
        const owner = req.headers['x-local-owner'];
        if (!users.includes(owner)) throw new UnauthorizedException();
        req.user = { id: owner };
        return true;
      },
    })
    .compile();
  app = module.createNestApplication({ logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function call(method, path = '', owner = users[0], body, status = 200) {
    const response = await fetch(`${base}/v1/me/favorites${path}`, {
      method,
      headers: {
        ...(owner ? { 'x-local-owner': owner } : {}),
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${await response.clone().text()}`,
    );
    checks++;
    return status === 204 ? undefined : response.json();
  }
  await call('GET', '', '', undefined, 401);
  await call('GET', '?userId=other', users[0], undefined, 400);
  await call('PUT', '/bad.id', users[0], undefined, 400);
  await call('GET', '?limit=0', users[0], undefined, 400);
  await call('GET', '?pageToken=bad', users[0], undefined, 400);
  await call(
    'POST',
    '/import',
    users[0],
    { importId: 'oversize', partIds: Array(101).fill(parts[0]) },
    400,
  );
  for (const id of hidden)
    await call('PUT', `/${id}`, users[0], undefined, 404);
  const hiddenReceipt = await call('POST', '/import', users[0], {
    importId: 'hidden-batch',
    partIds: hidden,
  });
  assert.deepEqual(hiddenReceipt.acceptedIds, []);
  assert.deepEqual(hiddenReceipt.missingIds, [...hidden].sort());
  // Existing saved IDs remain recoverable when listings become hidden.
  await prisma.userFavorite.create({
    data: { userId: users[1], partId: hidden[0] },
  });
  assert.equal((await call('GET', '', users[1])).items[0].partId, hidden[0]);
  await call('DELETE', `/${hidden[0]}`, users[1], undefined, 204);
  const first = await call('PUT', `/${parts[0]}`);
  assert.deepEqual(await call('PUT', `/${parts[0]}`), first);
  assert.deepEqual((await call('GET', '', users[1])).items, []);
  await call('DELETE', `/${parts[0]}`, users[1], undefined, 204);
  assert.equal((await call('GET')).items.length, 1);
  const payload = {
    importId: 'stable-batch',
    partIds: [...parts, `${prefix}_missing`, parts[0]],
  };
  const [receipt, concurrent] = await Promise.all([
    call('POST', '/import', users[0], payload),
    call('POST', '/import', users[0], payload),
  ]);
  assert.deepEqual(receipt, concurrent);
  assert.equal(receipt.acceptedIds.length, 4);
  assert.deepEqual(receipt.missingIds, [`${prefix}_missing`]);
  await call('DELETE', `/${parts[0]}`, users[0], undefined, 204);
  assert.deepEqual(await call('POST', '/import', users[0], payload), receipt);
  assert(!(await call('GET')).items.some((p) => p.partId === parts[0]));
  await call(
    'POST',
    '/import',
    users[0],
    { importId: payload.importId, partIds: [parts[1]] },
    409,
  );
  await prisma.userFavorite.updateMany({
    where: { userId: users[0] },
    data: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
  });
  const page = await call('GET', '?limit=1');
  await call(
    'GET',
    `?pageToken=${page.nextPageToken}`,
    users[1],
    undefined,
    400,
  );
  await call('DELETE', `/${page.items[0].partId}`, users[0], undefined, 204);
  const rest = await call('GET', `?limit=1&pageToken=${page.nextPageToken}`);
  assert.equal(rest.items.length, 1);
  const last = await call('GET', `?limit=1&pageToken=${rest.nextPageToken}`);
  assert.equal(
    new Set([...page.items, ...rest.items, ...last.items].map((p) => p.partId))
      .size,
    3,
  );
  assert.equal(last.nextPageToken, null);
  await call('PUT', `/${parts[1]}`, users[1]);
  const deletion = new AccountDeletionService(
    prisma,
    { deleteImage: async () => {} },
    { revokeAllSessions: async () => {}, notifySessionsRevoked: () => {} },
  );
  await deletion.deleteAccount(users[0]);
  assert.equal(
    await prisma.userFavorite.count({ where: { userId: users[0] } }),
    0,
  );
  assert.equal(
    await prisma.favoriteImport.count({ where: { userId: users[0] } }),
    0,
  );
  await call('PUT', `/${parts[2]}`, users[0], undefined, 401);
  assert.equal((await call('GET', '', users[1])).items.length, 1);
  console.log(
    `Local PostgreSQL + Nest HTTP: ${checks} responses verified; ownership, validation, concurrency, receipts, deletion, keyset pagination passed.`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close();
    await prisma.appUser.deleteMany({ where: { id: { in: users } } });
    await prisma.catalogPart.deleteMany({
      where: { id: { in: [...parts, ...hidden] } },
    });
    await prisma.catalogSeller.deleteMany({
      where: { id: { in: [prefix, `${prefix}_hidden`] } },
    });
    await prisma.partCategory.deleteMany({ where: { id: prefix } });
    await prisma.$disconnect();
  });
