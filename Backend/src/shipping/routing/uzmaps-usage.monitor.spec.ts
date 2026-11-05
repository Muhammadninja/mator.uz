/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- reads the arguments of a jest spy, which are untyped */
// Watching the UzMaps allowance, from UzMaps' own count. axios is stubbed.

import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { UzmapsUsageMonitor } from './uzmaps-usage.monitor';

const quota = (limit: number, used: number) =>
  ({
    data: {
      requests: used,
      quota: { limit, used, remaining: limit - used, resets: '2026-12-01' },
    },
  }) as AxiosResponse;

describe('UzmapsUsageMonitor', () => {
  let get: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const metrics = { setUzmapsQuota: jest.fn() };
  const monitor = (env: Record<string, string>) =>
    new UzmapsUsageMonitor(
      { get: (key: string) => env[key] } as never,
      metrics as never,
    );

  beforeEach(() => {
    metrics.setUzmapsQuota.mockClear();
    get = jest.spyOn(axios, 'get');
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('with no key there is nothing to read', async () => {
    await monitor({}).check();
    expect(get).not.toHaveBeenCalled();
  });

  it('reads one key once, when search shares it with routing', async () => {
    get.mockResolvedValue(quota(100, 10));

    await monitor({ UZMAPS_API_KEY: 'routing' }).check();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      'https://uzmaps.uz/api/usage',
      expect.objectContaining({ headers: { 'X-API-Key': 'routing' } }),
    );
    expect(metrics.setUzmapsQuota.mock.calls).toEqual([['routing', 100, 10]]);
  });

  it('reads each key when they are separate', async () => {
    get.mockResolvedValue(quota(100, 10));

    await monitor({
      UZMAPS_API_KEY: 'routing',
      UZMAPS_SEARCH_API_KEY: 'search',
    }).check();

    expect(metrics.setUzmapsQuota.mock.calls.map(([role]) => role)).toEqual([
      'routing',
      'search',
    ]);
  });

  it.each([
    [50, 0, 0],
    [80, 1, 0],
    [94, 1, 0],
    [95, 0, 1],
    [100, 0, 1],
  ])('at %i%% used: %i warnings, %i alarms', async (used, warns, alarms) => {
    get.mockResolvedValue(quota(100, used));

    await monitor({ UZMAPS_API_KEY: 'k' }).check();

    expect(warn).toHaveBeenCalledTimes(warns);
    expect(error).toHaveBeenCalledTimes(alarms);
  });

  it('a key with no monthly limit reports nothing, and is no problem', async () => {
    get.mockResolvedValue({ data: { requests: 5 } } as AxiosResponse);

    await monitor({ UZMAPS_API_KEY: 'k' }).check();

    expect(metrics.setUzmapsQuota).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('failing to read is only logged, with no key in the line', async () => {
    get.mockRejectedValue(
      new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 503,
      } as AxiosResponse),
    );

    await expect(
      monitor({ UZMAPS_API_KEY: 'secret-key' }).check(),
    ).resolves.toBeUndefined();

    expect(String(warn.mock.calls[0][0])).toContain('503');
    expect(String(warn.mock.calls[0][0])).not.toContain('secret-key');
  });
});
