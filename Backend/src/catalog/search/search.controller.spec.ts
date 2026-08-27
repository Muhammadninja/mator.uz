/**
 * The header→language wiring, at the boundary where it actually happens.
 *
 * The parser itself is covered exhaustively in common/app-lang.util.spec; what
 * is proved here is that the CONTROLLER reads `Accept-Language`, applies the
 * documented precedence, and can never hand the service anything but a
 * supported language — the guarantee behind "a missing header is never a 500
 * or a blank label".
 */

import { SearchController } from './search.controller';
import { SearchService } from './search.service';

describe('SearchController — Accept-Language', () => {
  let service: { search: jest.Mock };
  let controller: SearchController;

  beforeEach(() => {
    service = { search: jest.fn().mockResolvedValue({ results: [] }) };
    controller = new SearchController(service as unknown as SearchService);
  });

  /** The language the controller resolved for a given header. */
  const langFor = async (header?: string, dto: object = {}) => {
    await controller.universalSearch(dto as never, header);
    return service.search.mock.calls.at(-1)?.[1];
  };

  it.each([
    ['ru', 'ru'],
    ['uz', 'uz'],
    ['en', 'en'],
  ])('passes the bare code %p through as %p', async (header, expected) => {
    expect(await langFor(header)).toBe(expected);
  });

  it.each([
    ['ru-RU', 'ru'],
    ['uz-UZ', 'uz'],
    ['en-US', 'en'],
  ])('widens the regional tag %p to %p', async (header, expected) => {
    expect(await langFor(header)).toBe(expected);
  });

  it('picks the best supported language from a weighted list', async () => {
    expect(await langFor('de-DE,uz;q=0.9,ru;q=0.5')).toBe('uz');
  });

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['an unsupported language', 'de-DE'],
    ['a language we do not ship', 'fr,es;q=0.8'],
  ])('falls back to the default for %s', async (_label, header) => {
    expect(await langFor(header)).toBe('ru');
  });

  // The body's `locale` is the app's explicit in-app language choice, which can
  // differ from the device language the header reports.
  it('lets the body locale override the header', async () => {
    expect(await langFor('ru-RU', { locale: 'uz' })).toBe('uz');
  });

  it('falls back to the header when the body carries no locale', async () => {
    expect(await langFor('en-US', { query: 'brake' })).toBe('en');
  });

  it('ignores an unsupported body locale rather than failing', async () => {
    expect(await langFor('uz-UZ', { locale: 'de' })).toBe('ru');
  });

  it('always hands the service a supported language', async () => {
    for (const header of [undefined, '', '*', ';;;', 'zz-ZZ', 'ru;q=0']) {
      expect(['ru', 'uz', 'en']).toContain(await langFor(header));
    }
  });

  it('passes the request body through untouched', async () => {
    const dto = { query: 'brake', filters: { categories: ['brake-pads'] } };
    await controller.universalSearch(dto as never, 'uz');
    expect(service.search).toHaveBeenCalledWith(dto, 'uz');
  });
});
