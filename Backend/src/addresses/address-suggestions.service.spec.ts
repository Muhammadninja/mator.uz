/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the mocks and the in-memory Redis double are untyped by design */
// What a buyer gets back while choosing a place. The providers are stand-ins, the cache is
// the real one over an in-memory Redis.

import { ServiceUnavailableException } from '@nestjs/common';
import {
  fakeConfig,
  fakeRedis,
  TEST_DELIVERY_COVERAGE,
} from '../../test/utils/harness';
import { CacheService } from '../redis/cache.service';
import { AddressSuggestionsService } from './address-suggestions.service';
import {
  AddressSearchUnavailableError,
  FoundAddress,
} from './search/address-search-provider';
import { ReverseGeocodingUnavailableError } from './search/reverse-geocoding-provider';

const found = (over: Partial<FoundAddress> = {}): FoundAddress => ({
  id: '1',
  title: 'Amir Temur 12',
  subtitle: 'Yunusobod, Toshkent',
  city: 'Toshkent',
  district: 'Yunusobod',
  street: 'Amir Temur',
  house: '12',
  lat: 41.31,
  lng: 69.28,
  ...over,
});

const AT_THE_POINT = {
  city: 'Toshkent',
  district: 'Chilonzor',
  street: 'Seul',
  house: null,
};

describe('AddressSuggestionsService', () => {
  let search: jest.Mock;
  let describePoint: jest.Mock;
  let redis: ReturnType<typeof fakeRedis>;
  const WITH_AREA = { DELIVERY_COVERAGE_POLYGON: TEST_DELIVERY_COVERAGE };
  const service = (env: Record<string, string> = WITH_AREA) =>
    new AddressSuggestionsService(
      { attribution: 'search credit', search },
      { attribution: 'map credit', describe: describePoint },
      new CacheService(redis),
      fakeConfig(env),
    );

  beforeEach(() => {
    redis = fakeRedis();
    search = jest.fn().mockResolvedValue([found()]);
    describePoint = jest.fn().mockResolvedValue(AT_THE_POINT);
  });

  describe('suggest', () => {
    it('asks in the language named, defaulting to Uzbek, for a tidy street and house', async () => {
      await service().suggest({
        street: ' Amir Temur ',
        house: ' 12 ',
        lang: 'ru',
      });
      expect(search.mock.calls[0][0]).toMatchObject({
        street: 'Amir Temur',
        house: '12',
        language: 'ru',
        limit: 8,
        mode: 'autocomplete',
      });

      await service().suggest({ street: 'Amir', house: '  ' });
      expect(search.mock.calls[1][0]).toMatchObject({
        house: undefined,
        language: 'uz',
      });
    });

    it('passes on a submitted search', async () => {
      await service().suggest({ street: 'Amir', mode: 'search' });
      expect(search.mock.calls[0][0].mode).toBe('search');
    });

    it('limits the search to the area, when there is one', async () => {
      await service().suggest({ street: 'Amir' });
      expect(search.mock.calls[0][0].bounds).toEqual({
        minLng: 55,
        minLat: 37,
        maxLng: 74,
        maxLat: 46,
      });
    });

    it('takes where the map is looking, roughly, and only as a pair', async () => {
      await service().suggest({
        street: 'Amir',
        near_lat: 41.311081,
        near_lng: 69.240562,
      });
      expect(search.mock.calls[0][0].near).toEqual({ lat: 41.31, lng: 69.24 });

      await service().suggest({ street: 'Amir 2', near_lat: 41.31 });
      expect(search.mock.calls[1][0]).not.toHaveProperty('near');
    });

    it('answers with the matches and the credit their licence needs', async () => {
      await expect(service().suggest({ street: 'Amir' })).resolves.toEqual({
        items: [
          {
            id: '1',
            title: 'Amir Temur 12',
            subtitle: 'Yunusobod, Toshkent',
            city: 'Toshkent',
            district: 'Yunusobod',
            street: 'Amir Temur',
            house_number: '12',
            lat: 41.31,
            lng: 69.28,
          },
        ],
        attribution: 'search credit',
      });
    });

    it('offers nothing the address endpoint would then refuse', async () => {
      search.mockResolvedValue([
        found({ id: 'inside' }),
        found({ id: 'outside', lat: 55.75, lng: 37.61 }),
      ]);

      const { items } = await service().suggest({ street: 'Amir' });

      expect(items.map((item) => item.id)).toEqual(['inside']);
    });

    it('filters nothing and sends no box when no area is configured', async () => {
      search.mockResolvedValue([found({ lat: 55.75, lng: 37.61 })]);

      const { items } = await service({}).suggest({ street: 'Amir' });

      expect(items).toHaveLength(1);
      expect(search.mock.calls[0][0]).not.toHaveProperty('bounds');
    });

    it('puts the city the buyer typed first, and drops nothing for not naming it', async () => {
      search.mockResolvedValue([
        found({
          id: 'samarqand',
          city: 'Samarqand',
          subtitle: 'Samarqand',
          district: null,
        }),
        found({
          id: 'toshkent',
          city: 'Toshkent',
          subtitle: 'Toshkent',
          district: null,
        }),
      ]);

      const { items } = await service().suggest({
        street: 'Amir',
        city: ' toshkent ',
      });

      expect(items.map((item) => item.id)).toEqual(['toshkent', 'samarqand']);
    });

    it('no match is an empty list', async () => {
      search.mockResolvedValue([]);
      await expect(service().suggest({ street: 'zzz' })).resolves.toMatchObject(
        { items: [] },
      );
    });

    describe('the cache', () => {
      it('spares a paid call for the same search, whatever the case', async () => {
        const s = service();
        await s.suggest({ street: 'Amir Temur', house: '12', lang: 'ru' });
        await s.suggest({ street: 'AMIR TEMUR', house: '12', lang: 'ru' });

        expect(search).toHaveBeenCalledTimes(1);
      });

      it('remembers finding nothing too', async () => {
        search.mockResolvedValue([]);
        const s = service();
        await s.suggest({ street: 'zzz' });
        await s.suggest({ street: 'zzz' });
        expect(search).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['another street', { street: 'Navoiy' }],
        ['another house', { street: 'Amir', house: '13' }],
        ['another language', { street: 'Amir', lang: 'en' as const }],
        ['a submitted search', { street: 'Amir', mode: 'search' as const }],
        [
          'another part of the map',
          { street: 'Amir', near_lat: 39.65, near_lng: 66.96 },
        ],
      ])('%s is another search', async (_, other) => {
        const s = service();
        await s.suggest({ street: 'Amir' });
        await s.suggest(other);
        expect(search).toHaveBeenCalledTimes(2);
      });

      it('moving the map a few metres is the same search', async () => {
        const s = service();
        await s.suggest({
          street: 'Amir',
          near_lat: 41.31101,
          near_lng: 69.24001,
        });
        await s.suggest({
          street: 'Amir',
          near_lat: 41.31102,
          near_lng: 69.24002,
        });
        expect(search).toHaveBeenCalledTimes(1);
      });

      it('holds no typed text in its keys, and keeps entries for an hour', async () => {
        await service().suggest({ street: 'Amir Temur' });

        const [key] = [...redis.store.keys()];
        expect(key).toMatch(/^cache:address:search:[0-9a-f]{64}$/);
        expect(redis.ttls.get(key)).toBe(60 * 60);
      });

      it('remembers no failure: the next buyer asks again', async () => {
        search.mockRejectedValueOnce(new AddressSearchUnavailableError('down'));
        const s = service();
        await s.suggest({ street: 'Amir' }).catch(() => undefined);

        await expect(s.suggest({ street: 'Amir' })).resolves.toMatchObject({
          items: [{ id: '1' }],
        });
      });
    });

    it('a provider giving no answer is a 503 with a code', async () => {
      search.mockRejectedValue(new AddressSearchUnavailableError('down'));

      await expect(service().suggest({ street: 'Amir' })).rejects.toMatchObject(
        { status: 503, response: { code: 'ADDRESS_SEARCH_UNAVAILABLE' } },
      );
      await service()
        .suggest({ street: 'Amir' })
        .catch((err: unknown) =>
          expect(err).toBeInstanceOf(ServiceUnavailableException),
        );
    });

    it('an unexpected fault stays visible as one', async () => {
      search.mockRejectedValue(new TypeError('bug'));
      await expect(
        service().suggest({ street: 'Amir' }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe('describePoint', () => {
    const POINT = { lat: 41.2995, lng: 69.2401 };

    it('says what is known, whether couriers go there, and credits the data', async () => {
      await expect(
        service().describePoint({ ...POINT, lang: 'ru' }),
      ).resolves.toEqual({
        address: {
          city: 'Toshkent',
          district: 'Chilonzor',
          street: 'Seul',
          house_number: null,
        },
        within_coverage: true,
        attribution: 'map credit',
      });
      expect(describePoint).toHaveBeenCalledWith(POINT, 'ru');
    });

    it('a point with no known address is not a failure', async () => {
      describePoint.mockResolvedValue(null);

      await expect(service().describePoint(POINT)).resolves.toEqual({
        address: null,
        within_coverage: true,
        attribution: null,
      });
    });

    it.each([
      ['gives no answer', new ReverseGeocodingUnavailableError('down')],
      ['breaks', new TypeError('bug')],
    ])('never fails when the provider %s', async (_, error) => {
      describePoint.mockRejectedValue(error);

      await expect(service().describePoint(POINT)).resolves.toEqual({
        address: null,
        within_coverage: true,
        attribution: null,
      });
    });

    it('spends nothing on a place that is about to be refused', async () => {
      await expect(
        service().describePoint({ lat: 55.75, lng: 37.61 }),
      ).resolves.toEqual({
        address: null,
        within_coverage: false,
        attribution: null,
      });
      expect(describePoint).not.toHaveBeenCalled();
    });

    it('with no area configured it cannot say, and still describes the point', async () => {
      await expect(service({}).describePoint(POINT)).resolves.toMatchObject({
        within_coverage: null,
        address: { street: 'Seul' },
      });
    });

    it('asks once for a point confirmed twice, and remembers finding nothing', async () => {
      describePoint.mockResolvedValue(null);
      const s = service();
      await s.describePoint(POINT);
      await s.describePoint(POINT);
      expect(describePoint).toHaveBeenCalledTimes(1);
    });

    it('holds no location in its keys, and keeps entries for a day', async () => {
      await service().describePoint(POINT);

      const [key] = [...redis.store.keys()];
      expect(key).toMatch(/^cache:address:reverse:[0-9a-f]{64}$/);
      expect(key).not.toContain('41.29');
      expect(redis.ttls.get(key)).toBe(24 * 60 * 60);
    });

    it('does not remember a failure', async () => {
      describePoint.mockRejectedValueOnce(
        new ReverseGeocodingUnavailableError('down'),
      );
      const s = service();
      await s.describePoint(POINT);

      await expect(s.describePoint(POINT)).resolves.toMatchObject({
        address: { street: 'Seul' },
      });
    });

    it('refuses a point that is no place at all', async () => {
      await expect(
        service().describePoint({ lat: 0, lng: 0 }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'DELIVERY_ADDRESS_COORDINATES_INVALID' },
      });
      expect(describePoint).not.toHaveBeenCalled();
    });
  });
});
