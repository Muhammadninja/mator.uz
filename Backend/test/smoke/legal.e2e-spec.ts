import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { LegalDocumentType } from '@prisma/client';
import { LegalModule } from '../../src/legal/legal.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { fakeRedis, FakeQueueModule } from '../utils/harness';

/**
 * REAL HTTP smoke tests for /v1/legal/*. Boots the module behind the same
 * ValidationPipe and exception filter main.ts installs, and asserts the JSON
 * that actually goes over the wire — not the TypeScript types or the Swagger
 * annotations, which can drift from runtime independently.
 *
 * The store is an in-memory stand-in for Prisma, so this exercises routing,
 * validation, locale negotiation, guards, serialization and error shaping
 * without a database.
 */

const T = new Date('2026-08-31T00:00:00.000Z');

interface Row {
  id: string;
  type: LegalDocumentType;
  version: number;
  locale: string;
  title: string;
  content: string;
  contentFormat: string;
  isActive: boolean;
  effectiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function seedRows(): Row[] {
  return Object.values(LegalDocumentType).flatMap((type) =>
    ['ru', 'uz', 'en'].map((locale) => ({
      id: `${type}|1|${locale}`,
      type,
      version: 1,
      locale,
      title: `${type} (${locale})`,
      content: `body ${type} ${locale}`,
      contentFormat: 'markdown',
      isActive: true,
      effectiveAt: T,
      createdAt: T,
      updatedAt: T,
    })),
  );
}

/** Minimal Prisma stand-in covering only the queries LegalService issues. */
function prismaStub(documents: Row[], acceptances: any[]) {
  const matches = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const api: any = {
    legalDocument: {
      findFirst: ({ where = {}, orderBy }: any = {}) => {
        let f = documents.filter((d) => matches(d, where));
        if (orderBy?.locale === 'asc') {
          f = [...f].sort((a, b) => a.locale.localeCompare(b.locale));
        }
        if (orderBy?.version === 'desc') {
          f = [...f].sort((a, b) => b.version - a.version);
        }
        return Promise.resolve(f[0] ?? null);
      },
      findUnique: ({ where }: any) => {
        const k = where.type_version_locale;
        return Promise.resolve(
          documents.find(
            (d) =>
              d.type === k.type && d.version === k.version && d.locale === k.locale,
          ) ?? null,
        );
      },
    },
    legalAcceptance: {
      findMany: ({ where = {}, include, select }: any = {}) => {
        const f = acceptances.filter((a) => {
          if (where.userId !== undefined && a.userId !== where.userId) return false;
          const types = where.document?.type?.in;
          if (types) {
            const doc = documents.find((d) => d.id === a.documentId);
            if (!doc || !types.includes(doc.type)) return false;
          }
          return true;
        });
        const withDoc = (a: any) => ({
          ...a,
          document: documents.find((d) => d.id === a.documentId)!,
        });
        return Promise.resolve(
          include?.document || select?.document ? f.map(withDoc) : f,
        );
      },
      createMany: ({ data }: any) => {
        acceptances.push(
          ...data.map((r: any, i: number) => ({
            ...r,
            id: `acc_${acceptances.length + i}`,
            acceptedAt: T,
          })),
        );
        return Promise.resolve({ count: data.length });
      },
    },
  };
  api.$transaction = (cb: any) => cb(api);
  return api;
}

describe('Legal API (e2e)', () => {
  let app: INestApplication;
  let mod: TestingModule;
  let documents: Row[];
  let acceptances: any[];
  let authed = true;

  beforeEach(async () => {
    documents = seedRows();
    acceptances = [];

    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        // PrismaModule and RedisModule are @Global via AppModule in production;
        // a standalone testing module must put them in the graph itself.
        PrismaModule,
        RedisModule,
        FakeQueueModule,
        LegalModule,
      ],
      // The real app binds ThrottlerGuard globally; not needed here, and binding
      // it would require a live store.
      providers: [{ provide: APP_GUARD, useValue: { canActivate: () => true } }],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub(documents, acceptances))
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      // Stands in for the JWT strategy: attaches a fixed principal, or refuses,
      // so the guard's PRESENCE on each route is what is being tested.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          // Throws like the real passport guard does (401), rather than
          // returning false (which Nest renders as 403) — otherwise the status
          // asserted below would be an artefact of the stub.
          if (!authed) throw new UnauthorizedException();
          ctx.switchToHttp().getRequest().user = { id: 'user_1' };
          return true;
        },
      })
      .compile();

    app = mod.createNestApplication();
    // Exactly what main.ts installs.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    authed = true;
  });

  afterEach(async () => {
    await app?.close();
    await mod?.close();
  });

  const ALL = {
    acceptances: Object.values(LegalDocumentType).map((type) => ({
      type,
      version: 1,
    })),
  };

  describe('GET /v1/legal/documents', () => {
    it('is PUBLIC and returns all three documents in the snake_case contract', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/legal/documents')
        .expect(200);

      expect(Object.keys(res.body)).toEqual(['documents']);
      expect(res.body.documents).toHaveLength(3);
      expect(Object.keys(res.body.documents[0]).sort()).toEqual([
        'content',
        'content_format',
        'effective_at',
        'is_required',
        'locale',
        'title',
        'type',
        'version',
      ]);
      // No Prisma internals on the wire.
      const raw = JSON.stringify(res.body);
      for (const leaked of ['"id"', 'isActive', 'createdAt', 'updatedAt']) {
        expect(raw).not.toContain(leaked);
      }
      expect(res.body.documents.every((d: any) => d.is_required)).toBe(true);
    });

    it('returns a STABLE document order across calls', async () => {
      const order = async () =>
        (await request(app.getHttpServer()).get('/v1/legal/documents')).body.documents.map(
          (d: any) => d.type,
        );
      expect(await order()).toEqual(await order());
      expect(await order()).toEqual([
        'TERMS_OF_USE',
        'PRIVACY_POLICY',
        'PERSONAL_DATA_CONSENT',
      ]);
    });

    it.each([
      ['ru', 'ru'],
      ['uz', 'uz'],
      ['en', 'en'],
      ['ru-RU', 'ru'],
      ['uz-UZ', 'uz'],
      ['en-US', 'en'],
      ['en-US,en;q=0.9', 'en'],
      ['fr', 'ru'],
      ['', 'ru'],
    ])('negotiates Accept-Language %p -> locale %p', async (header, expected) => {
      const req = request(app.getHttpServer()).get('/v1/legal/documents');
      if (header) req.set('Accept-Language', header);
      const res = await req.expect(200);
      expect(res.body.documents.every((d: any) => d.locale === expected)).toBe(true);
    });

    it('falls back rather than returning an empty list when a locale is absent', async () => {
      // Drop every non-ru row: an `en` client must still get three documents.
      documents.splice(0, documents.length, ...seedRows().filter((d) => d.locale === 'ru'));
      const res = await request(app.getHttpServer())
        .get('/v1/legal/documents')
        .set('Accept-Language', 'en')
        .expect(200);
      expect(res.body.documents).toHaveLength(3);
      expect(res.body.documents.every((d: any) => d.locale === 'ru')).toBe(true);
    });
  });

  describe('GET /v1/legal/documents/:type/:version', () => {
    it('serves a specific version publicly', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/legal/documents/PRIVACY_POLICY/1')
        .set('Accept-Language', 'en')
        .expect(200);
      expect(res.body.type).toBe('PRIVACY_POLICY');
      expect(res.body.version).toBe(1);
      expect(res.body.locale).toBe('en');
    });

    it('400s on an unknown document type', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/legal/documents/COOKIE_BANNER/1')
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('400s on a non-numeric version', async () => {
      await request(app.getHttpServer())
        .get('/v1/legal/documents/PRIVACY_POLICY/abc')
        .expect(400);
    });

    it('404s on a version that does not exist', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/legal/documents/PRIVACY_POLICY/99')
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /v1/legal/status', () => {
    it('requires authentication', async () => {
      authed = false;
      const res = await request(app.getHttpServer())
        .get('/v1/legal/status')
        .expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('reports requires_acceptance for a new user in the snake_case contract', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/legal/status')
        .expect(200);
      expect(res.body.requires_acceptance).toBe(true);
      expect(res.body.documents).toHaveLength(3);
      expect(Object.keys(res.body.documents[0]).sort()).toEqual([
        'accepted',
        'accepted_version',
        'required_version',
        'type',
      ]);
      expect(res.body.documents[0].accepted_version).toBeNull();
    });
  });

  describe('POST /v1/legal/accept', () => {
    it('requires authentication', async () => {
      authed = false;
      await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .send(ALL)
        .expect(401);
      expect(acceptances).toHaveLength(0);
    });

    it('records consent and returns the resulting status in one round trip', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .set('Accept-Language', 'en')
        .set('User-Agent', 'MatorApp/3.0 (iOS 18)')
        .send(ALL)
        .expect(200);

      expect(res.body.requires_acceptance).toBe(false);
      expect(res.body.documents.every((d: any) => d.accepted)).toBe(true);
      expect(acceptances).toHaveLength(3);
      // Provenance came from the REQUEST, not the body.
      expect(acceptances.every((a) => a.userAgent === 'MatorApp/3.0 (iOS 18)')).toBe(true);
      expect(acceptances.every((a) => a.locale === 'en')).toBe(true);
      expect(acceptances.every((a) => typeof a.ipAddress === 'string')).toBe(true);
      expect(acceptances.every((a) => a.userId === 'user_1')).toBe(true);
    });

    it('ignores a userId in the body — the principal comes from the token', async () => {
      await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .send({ ...ALL, userId: 'victim' })
        .expect(400); // forbidNonWhitelisted rejects it outright
      expect(acceptances).toHaveLength(0);
    });

    it('rejects a stale version with LEGAL_ACCEPTANCE_REQUIRED', async () => {
      documents.forEach((d) => {
        if (d.type === LegalDocumentType.PRIVACY_POLICY) d.version = 2;
      });
      const res = await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .send(ALL)
        .expect(400);
      expect(res.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
      expect(acceptances).toHaveLength(0);
    });

    it.each([
      ['missing documents', { acceptances: [{ type: 'TERMS_OF_USE', version: 1 }] }],
      ['empty array', { acceptances: [] }],
      [
        'duplicate types',
        {
          acceptances: [
            { type: 'PRIVACY_POLICY', version: 1 },
            { type: 'PRIVACY_POLICY', version: 2 },
          ],
        },
      ],
      ['unknown type', { acceptances: [{ type: 'COOKIE_BANNER', version: 1 }] }],
      ['version 0', { acceptances: [{ type: 'TERMS_OF_USE', version: 0 }] }],
    ])('400s on %s and writes nothing', async (_name, body) => {
      await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .send(body)
        .expect(400);
      expect(acceptances).toHaveLength(0);
    });

    it('is idempotent across a retry AND a language switch', async () => {
      await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .set('Accept-Language', 'ru')
        .send(ALL)
        .expect(200);
      await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .set('Accept-Language', 'en')
        .send(ALL)
        .expect(200);

      expect(acceptances).toHaveLength(3);
    });

    it('supports the full rollout flow: accept v1 -> v2 published -> re-accept', async () => {
      await request(app.getHttpServer()).post('/v1/legal/accept').send(ALL).expect(200);
      expect(
        (await request(app.getHttpServer()).get('/v1/legal/status')).body
          .requires_acceptance,
      ).toBe(false);

      // Publish PRIVACY_POLICY v2 in every locale.
      documents.forEach((d) => {
        if (d.type === LegalDocumentType.PRIVACY_POLICY) d.isActive = false;
      });
      for (const locale of ['ru', 'uz', 'en']) {
        documents.push({
          ...seedRows()[0],
          id: `PRIVACY_POLICY|2|${locale}`,
          type: LegalDocumentType.PRIVACY_POLICY,
          version: 2,
          locale,
          isActive: true,
        });
      }

      const stale = await request(app.getHttpServer()).get('/v1/legal/status').expect(200);
      expect(stale.body.requires_acceptance).toBe(true);
      const privacy = stale.body.documents.find((d: any) => d.type === 'PRIVACY_POLICY');
      expect(privacy).toMatchObject({
        required_version: 2,
        accepted_version: 1,
        accepted: false,
      });
      expect(privacy.accepted_at).toBeDefined();

      // GET documents now offers v2.
      const docs = await request(app.getHttpServer()).get('/v1/legal/documents').expect(200);
      expect(
        docs.body.documents.find((d: any) => d.type === 'PRIVACY_POLICY').version,
      ).toBe(2);

      await request(app.getHttpServer())
        .post('/v1/legal/accept')
        .send({
          acceptances: [
            { type: 'TERMS_OF_USE', version: 1 },
            { type: 'PRIVACY_POLICY', version: 2 },
            { type: 'PERSONAL_DATA_CONSENT', version: 1 },
          ],
        })
        .expect(200);

      const after = await request(app.getHttpServer()).get('/v1/legal/status').expect(200);
      expect(after.body.requires_acceptance).toBe(false);
      // History preserved: the v1 consent row still exists alongside the v2 one.
      expect(acceptances).toHaveLength(4);
      expect(
        acceptances.filter((a) => a.documentId.startsWith('PRIVACY_POLICY')).map((a) => a.documentVersion).sort(),
      ).toEqual([1, 2]);
    });
  });
});
