import { CatalogToolsService, CATALOG_TOOLS } from './catalog-tools.service';
import { ProductKind } from '@prisma/client';

/**
 * The catalogue tools are the ONLY channel through which a catalogue fact
 * reaches a reply, so these tests pin two things: that a tool call is
 * translated into the authoritative service call the buyer API would make, and
 * that nothing beyond the allowlisted fields is handed to the model.
 */

/** A part as PartsService.list()/detail() presents it (the real wire shape). */
function buildPresentedPart(over: Record<string, unknown> = {}) {
  return {
    id: 'part_pads',
    title: 'Brake pads front',
    kind: ProductKind.SPARE_PART,
    motor_oil: null,
    brand: { id: 'brand_bosch', name: 'Bosch' },
    category: { id: 'brakes', name: 'Brakes' },
    price_uzs: 185000,
    price_label: 'UZS 185 000',
    original_price_uzs: null,
    in_stock: true,
    rating_avg: 4.5,
    oem_numbers: ['13476876'],
    delivery_eta_days_min: 1,
    delivery_eta_days_max: 3,
    compatibility: { status: 'fits', confidence: 1, notes: null },
    seller: {
      id: 'seller_a',
      name: 'AutoPro',
      rating_avg: 4.8,
      certified: true,
      lowest_price: false,
    },
    ...over,
  };
}

describe('CatalogToolsService', () => {
  let parts: { list: jest.Mock; detail: jest.Mock };
  let categories: { list: jest.Mock };
  let tools: CatalogToolsService;

  beforeEach(() => {
    parts = { list: jest.fn(), detail: jest.fn() };
    categories = { list: jest.fn() };
    tools = new CatalogToolsService(parts as never, categories as never);
  });

  describe('tool definitions', () => {
    it('exposes exactly the four catalogue tools', () => {
      expect(CATALOG_TOOLS.map((t) => t.name).sort()).toEqual([
        'find_motor_oil',
        'get_categories',
        'get_product',
        'search_catalog',
      ]);
    });

    it('steers oil questions to find_motor_oil rather than the spare-part flow', () => {
      const oil = CATALOG_TOOLS.find((t) => t.name === 'find_motor_oil')!;
      expect(oil.description).toMatch(/NOT selected through the spare-part/i);
      expect(Object.keys(oil.input_schema.properties!)).toEqual(
        expect.arrayContaining(['viscosity', 'oil_type', 'volume_ml']),
      );
    });
  });

  describe('search_catalog', () => {
    it('delegates to PartsService.list — the same path GET /v1/catalog/parts uses', async () => {
      parts.list.mockResolvedValue({ items: [buildPresentedPart()], total: 1 });

      const res = await tools.run('search_catalog', {
        q: 'brake pads',
        make: 'Chevrolet',
        vehicle_id: 'veh_1',
      });

      expect(parts.list).toHaveBeenCalledTimes(1);
      const query = parts.list.mock.calls[0][0];
      expect(query.q).toBe('brake pads');
      expect(query.make).toBe('Chevrolet');
      expect(query.vehicle_id).toBe('veh_1');
      expect(JSON.parse(res.content).total).toBe(1);
      expect(res.itemCount).toBe(1);
    });

    it('returns only allowlisted fields — never internal cost or stock counts', async () => {
      parts.list.mockResolvedValue({
        items: [
          buildPresentedPart({
            purchase_price_uzs: 90000,
            stock_qty: 42,
            low_stock_threshold: 5,
          }),
        ],
        total: 1,
      });

      const res = await tools.run('search_catalog', { q: 'pads' });

      expect(res.content).not.toContain('purchase_price');
      expect(res.content).not.toContain('stock_qty');
      expect(res.content).not.toContain('90000');
      const item = JSON.parse(res.content).items[0];
      expect(item).toEqual({
        part_id: 'part_pads',
        title: 'Brake pads front',
        brand: 'Bosch',
        price_uzs: 185000,
        price_label: 'UZS 185 000',
        original_price_uzs: null,
        in_stock: true,
        seller: 'AutoPro',
        seller_certified: true,
        rating_avg: 4.5,
        compatibility: 'fits',
      });
    });

    it('clamps a model-requested page size to the tool ceiling', async () => {
      parts.list.mockResolvedValue({ items: [], total: 0 });
      await tools.run('search_catalog', { q: 'x', page_size: 500 });
      expect(parts.list.mock.calls[0][0].page_size).toBe(8);
    });

    it('reports an empty result as an answer, not an error', async () => {
      parts.list.mockResolvedValue({ items: [], total: 0 });
      const res = await tools.run('search_catalog', { q: 'nonexistent' });
      const payload = JSON.parse(res.content);
      expect(payload.items).toEqual([]);
      expect(payload.total).toBe(0);
      expect(payload.error).toBeUndefined();
      expect(res.itemCount).toBe(0);
    });

    it('surfaces the sale price and the struck-through original', async () => {
      parts.list.mockResolvedValue({
        items: [
          buildPresentedPart({ price_uzs: 150000, original_price_uzs: 185000 }),
        ],
        total: 1,
      });
      const item = JSON.parse((await tools.run('search_catalog', {})).content)
        .items[0];
      expect(item.price_uzs).toBe(150000);
      expect(item.original_price_uzs).toBe(185000);
    });
  });

  describe('find_motor_oil', () => {
    it('forces kind=motor_oil so the tool can never return a spare part', async () => {
      parts.list.mockResolvedValue({ items: [], total: 0 });
      await tools.run('find_motor_oil', {
        viscosity: '5W-30',
        oil_type: 'synthetic',
      });

      const query = parts.list.mock.calls[0][0];
      expect(query.kind).toEqual(['motor_oil']);
      expect(query.viscosity).toEqual(['5W-30']);
      expect(query.oil_type).toEqual(['synthetic']);
    });

    it('returns oil attributes instead of vehicle compatibility', async () => {
      parts.list.mockResolvedValue({
        items: [
          buildPresentedPart({
            id: 'part_oil',
            kind: ProductKind.MOTOR_OIL,
            compatibility: null,
            motor_oil: {
              viscosity: '5W-30',
              oil_type: 'SYNTHETIC',
              oil_type_label: 'Синтетическое',
              volume_ml: 4000,
              volume_label: '4 л',
            },
          }),
        ],
        total: 1,
      });

      const item = JSON.parse((await tools.run('find_motor_oil', {})).content)
        .items[0];
      expect(item.viscosity).toBe('5W-30');
      expect(item.oil_type).toBe('Синтетическое');
      expect(item.volume).toBe('4 л');
      expect(item.compatibility).toBeUndefined();
    });

    it('passes a numeric volume through as millilitres', async () => {
      parts.list.mockResolvedValue({ items: [], total: 0 });
      await tools.run('find_motor_oil', { volume_ml: 4000 });
      expect(parts.list.mock.calls[0][0].volume_ml).toEqual([4000]);
    });
  });

  describe('get_product', () => {
    it('returns the authoritative detail for a known part', async () => {
      parts.detail.mockResolvedValue(buildPresentedPart());
      const res = await tools.run('get_product', {
        part_id: 'part_pads',
        vehicle_id: 'veh_1',
      });

      expect(parts.detail).toHaveBeenCalledWith('part_pads', 'veh_1');
      const item = JSON.parse(res.content).items[0];
      expect(item.part_id).toBe('part_pads');
      expect(item.oem_numbers).toEqual(['13476876']);
    });

    it('reports an unknown part as a no-match answer, not a thrown failure', async () => {
      parts.detail.mockRejectedValue(new Error('Part not found'));
      const res = await tools.run('get_product', { part_id: 'part_ghost' });

      expect(JSON.parse(res.content).error).toMatch(/part_ghost/);
      expect(res.itemCount).toBe(0);
    });

    it('rejects a call with no part_id', async () => {
      const res = await tools.run('get_product', {});
      expect(JSON.parse(res.content).error).toMatch(/part_id is required/);
      expect(parts.detail).not.toHaveBeenCalled();
    });
  });

  describe('get_categories', () => {
    it('returns categories with live inventory counts', async () => {
      categories.list.mockResolvedValue({
        items: [
          {
            id: 'brakes',
            name: 'Brakes',
            slug: 'brakes',
            count: 12,
            iconKey: 'b',
            color: '#f00',
          },
        ],
        total: 1,
      });

      const res = await tools.run('get_categories', { scope: 'main' });
      expect(JSON.parse(res.content).items).toEqual([
        { id: 'brakes', name: 'Brakes', part_count: 12 },
      ]);
    });

    it('defaults an unrecognised scope to main rather than failing', async () => {
      categories.list.mockResolvedValue({ items: [], total: 0 });
      await tools.run('get_categories', { scope: 'nonsense' });
      expect(categories.list.mock.calls[0][0].scope).toBe('main');
    });
  });

  describe('failure handling', () => {
    it('converts an unknown tool name into a corrective result', async () => {
      const res = await tools.run('drop_table_users', {});
      expect(JSON.parse(res.content).error).toMatch(/Unknown tool/);
    });

    it('converts a catalogue outage into a recoverable tool result', async () => {
      parts.list.mockRejectedValue(new Error('connection refused'));
      const res = await tools.run('search_catalog', { q: 'pads' });

      const payload = JSON.parse(res.content);
      expect(payload.error).toMatch(/could not be reached/);
      expect(payload.items).toEqual([]);
      // The underlying reason must not leak to the model.
      expect(res.content).not.toContain('connection refused');
    });

    it('drops an invalid argument rather than failing the whole search', async () => {
      parts.list.mockResolvedValue({ items: [], total: 0 });
      await tools.run('search_catalog', { q: 'pads', sort: 'not_a_sort' });

      // The bad value is stripped; the usable part of the query survives.
      const query = parts.list.mock.calls[0][0];
      expect(query.q).toBe('pads');
      expect(query.sort).toBeUndefined();
    });
  });
});
