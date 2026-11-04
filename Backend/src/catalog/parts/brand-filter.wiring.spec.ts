import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { DiscountService } from '../../sales/discount.service';
import { PartsController } from './parts.controller';
import { PartsService } from './parts.service';
import {
  BOSCH,
  MANN,
  NO_DISCOUNTS,
  catalogPrisma,
  listedOf,
} from './brand-catalogue.test-util';

// Boots a real Nest HTTP app around the controller and the REAL PartsService
// (Prisma answered from the in-memory catalogue), with the global
// ValidationPipe exactly as main.ts installs it — so the query string is
// parsed, validated and transformed the way the app's requests are.
describe('GET /v1/catalog/parts?brand= (wiring)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PartsController],
      providers: [
        PartsService,
        { provide: PrismaService, useValue: catalogPrisma() },
        { provide: DiscountService, useValue: NO_DISCOUNTS },
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

  afterAll(async () => await app.close());

  /** The listing a 200 answers with, as far as these tests read it. */
  type Listing = {
    page: number;
    page_size: number;
    total: number;
    next_page: number | null;
    items: { id: string; brand: { id: string } | null }[];
  };

  const get = (query: Record<string, string | number>) =>
    request(app.getHttpServer()).get('/v1/catalog/parts').query(query);
  /** GET the listing with `query`; resolves to its body once it is a 200. */
  const listing = async (query: Record<string, string | number>) =>
    (await get(query).expect(200)).body as Listing;

  it('serves a later page of the brand: only Bosch, its total, the next page', async () => {
    const body = await listing({ brand: BOSCH, page: 2, page_size: 24 });
    expect(body).toMatchObject({
      page: 2,
      page_size: 24,
      total: 52,
      next_page: 3,
    });
    expect(body.items.map((i) => i.id)).toEqual(listedOf(BOSCH).slice(24, 48));
    expect(body.items.every((i) => i.brand?.id === BOSCH)).toBe(true);
  });

  it('takes several brands as one comma-separated value', async () => {
    const body = await listing({ brand: `${BOSCH},${MANN}`, page_size: 100 });
    expect(body.total).toBe(62);
    expect(
      body.items.every((i) => [BOSCH, MANN].includes(i.brand?.id ?? '')),
    ).toBe(true);
  });

  it('keeps every other filter of the request beside the brand', async () => {
    const body = await listing({
      brand: BOSCH,
      category: 'front-brake-pads',
      make: 'Chevrolet',
      model: 'Cobalt',
      q: 'pad',
      gm_only: 'false',
      sort: 'price_asc',
      page: 1,
      page_size: 24,
    });
    expect(body.total).toBe(9);
    expect(body.items.every((i) => i.brand?.id === BOSCH)).toBe(true);
  });

  it('still rejects a parameter the contract does not know', async () => {
    await get({ brand: BOSCH, brandId: BOSCH }).expect(400);
  });
});
