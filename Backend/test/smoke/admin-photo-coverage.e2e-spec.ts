// The photo-coverage console over HTTP, behind the REAL admin JWT strategy and
// role guard: who gets in, and that the query reaches the service validated.
// The service and Prisma are stubbed — nothing here touches a database.

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { AdminRole } from '@prisma/client';
import { createHmac } from 'crypto';
import request from 'supertest';
import { AdminAuthConfig } from '../../src/admin/auth/admin-auth.config';
import { AdminJwtStrategy } from '../../src/admin/auth/strategies/admin-jwt.strategy';
import { AdminTokenService } from '../../src/admin/auth/admin-token.service';
import { AdminPhotoCoverageController } from '../../src/admin/photo-coverage/admin-photo-coverage.controller';
import { AdminPhotoCoverageService } from '../../src/admin/photo-coverage/admin-photo-coverage.service';
import { PrismaService } from '../../src/prisma/prisma.service';

const SECRET = 'photo-coverage-test-secret-'.repeat(3);

function token(
  over: Record<string, unknown> = {},
  secret = SECRET,
): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: 'admin_1',
    role: AdminRole.OPERATOR,
    type: 'admin',
    tokenVersion: 0,
    iss: 'mator-admin',
    aud: 'mator-admin-panel',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...over,
  });
  const sig = createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `Bearer ${head}.${body}.${sig}`;
}

describe('GET /v1/admin/photo-coverage/*', () => {
  let app: INestApplication;
  const coverage = {
    summary: jest.fn().mockResolvedValue({ success: true, data: {} }),
    list: jest.fn().mockResolvedValue({ success: true, data: [], meta: {} }),
  };
  const prisma = {
    appAdmin: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'admin_1',
        email: 'op@mator.uz',
        name: 'Operator',
        role: AdminRole.OPERATOR,
        isActive: true,
        tokenVersion: 0,
        lastLoginAt: null,
        createdAt: new Date(),
      }),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminPhotoCoverageController],
      providers: [
        AdminJwtStrategy,
        { provide: AdminAuthConfig, useValue: { secret: SECRET } },
        // Logout / device revocation markers (LOW-ADM-008): none here.
        {
          provide: AdminTokenService,
          useValue: { isAccessTokenRevoked: async () => false },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: AdminPhotoCoverageService, useValue: coverage },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const get = (path: string, auth?: string) => {
    const req = request(app.getHttpServer()).get(
      `/v1/admin/photo-coverage/${path}`,
    );
    return auth ? req.set('Authorization', auth) : req;
  };

  it.each(['summary', 'parts'])('%s refuses a request with no token', async (path) => {
    await get(path).expect(401);
    expect(coverage.summary).not.toHaveBeenCalled();
    expect(coverage.list).not.toHaveBeenCalled();
  });

  it('refuses a token signed with another secret (e.g. an app-user token)', async () => {
    await get('summary', token({}, 'some-other-secret-'.repeat(3))).expect(401);
  });

  it('refuses a token that is not an admin token', async () => {
    await get('summary', token({ type: 'user' })).expect(401);
  });

  it('refuses an admin whose sessions were revoked', async () => {
    await get('summary', token({ tokenVersion: 7 })).expect(401);
  });

  it('lets an operator read the summary', async () => {
    await get('summary', token()).expect(200);
    expect(coverage.summary).toHaveBeenCalledTimes(1);
  });

  it('passes a validated, typed query to the list', async () => {
    await get(
      'parts?photo=without&categoryId=pads&page=2&limit=50',
      token(),
    ).expect(200);
    expect(coverage.list).toHaveBeenCalledWith(
      expect.objectContaining({
        photo: 'without',
        categoryId: 'pads',
        page: 2,
        limit: 50,
      }),
    );
  });

  it('answers 400 to an unknown photo filter or an unknown parameter', async () => {
    await get('parts?photo=maybe', token()).expect(400);
    await get('parts?sort=title', token()).expect(400);
    expect(coverage.list).not.toHaveBeenCalled();
  });
});
