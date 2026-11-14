import {
  parseVehicleImageConfig,
  readVehicleImageConfig,
  validateVehicleImageEnv,
} from './vehicle-image.config';

const TOKEN = 'a'.repeat(40);
const get = (env: Record<string, string>) => (key: string) => env[key];

describe('vehicle image config', () => {
  it('is off and valid by default', () => {
    expect(parseVehicleImageConfig(get({}))).toEqual({
      config: {
        enabled: false,
        baseUrl: null,
        requestToken: null,
        requestTimeoutMs: 10_000,
        adminToken: null,
        reconcileEnabled: false,
      },
      errors: [],
    });
    expect(() => validateVehicleImageEnv({})).not.toThrow();
  });

  it('reads the review console token and the reconcile switch, and checks the token', () => {
    const token = 'r'.repeat(40);
    const admin = 'a'.repeat(40);
    expect(
      parseVehicleImageConfig(
        get({
          VEHICLE_IMAGE_ADMIN_TOKEN: admin,
          VEHICLE_IMAGE_REQUEST_TOKEN: token,
          VEHICLE_IMAGE_RECONCILE_ENABLED: 'true',
        }),
      ).config,
    ).toMatchObject({ adminToken: admin, reconcileEnabled: true });
    expect(
      parseVehicleImageConfig(get({ VEHICLE_IMAGE_ADMIN_TOKEN: 'short' })).errors,
    ).toEqual([expect.stringMatching(/VEHICLE_IMAGE_ADMIN_TOKEN must be at least 32/)]);
    expect(
      parseVehicleImageConfig(
        get({ VEHICLE_IMAGE_ADMIN_TOKEN: token, VEHICLE_IMAGE_REQUEST_TOKEN: token }),
      ).errors,
    ).toEqual([expect.stringMatching(/must differ/)]);
    expect(
      parseVehicleImageConfig(get({ VEHICLE_IMAGE_RECONCILE_ENABLED: 'yes' })).config.reconcileEnabled,
    ).toBe(false);
  });

  it('refuses to boot enabled without URL and token', () => {
    expect(() =>
      validateVehicleImageEnv({ VEHICLE_IMAGES_ENABLED: 'true' }),
    ).toThrow(
      /VEHICLE_IMAGE_PIPELINE_URL is required[\s\S]*VEHICLE_IMAGE_REQUEST_TOKEN is required/,
    );
  });

  it('allows http only to loopback, and https anywhere', () => {
    const env = {
      VEHICLE_IMAGES_ENABLED: 'true',
      VEHICLE_IMAGE_REQUEST_TOKEN: TOKEN,
      VEHICLE_IMAGE_MARKET_REGION: 'UZ',
    };
    expect(() =>
      validateVehicleImageEnv({
        ...env,
        VEHICLE_IMAGE_PIPELINE_URL: 'http://10.0.0.5:8047',
      }),
    ).toThrow(/https/);
    expect(() =>
      validateVehicleImageEnv({
        ...env,
        VEHICLE_IMAGE_PIPELINE_URL: 'http://127.0.0.1:8047',
      }),
    ).not.toThrow();
    expect(
      parseVehicleImageConfig(
        get({
          ...env,
          VEHICLE_IMAGE_PIPELINE_URL: 'https://api.mator.uz/vehicle-images',
        }),
      ).config.baseUrl,
    ).toBe('https://api.mator.uz/vehicle-images/');
  });

  it('refuses a short token, credentials in the URL and a bad timeout', () => {
    const env = {
      VEHICLE_IMAGES_ENABLED: 'true',
      VEHICLE_IMAGE_PIPELINE_URL: 'https://x.test',
    };
    expect(() =>
      validateVehicleImageEnv({ ...env, VEHICLE_IMAGE_REQUEST_TOKEN: 'short' }),
    ).toThrow(/at least 32/);
    expect(() =>
      validateVehicleImageEnv({
        ...env,
        VEHICLE_IMAGE_REQUEST_TOKEN: TOKEN,
        VEHICLE_IMAGE_MARKET_REGION: 'UZ',
        VEHICLE_IMAGE_PIPELINE_URL: 'https://u:p@x.test',
      }),
    ).toThrow(/credentials/);
    expect(() =>
      validateVehicleImageEnv({
        ...env,
        VEHICLE_IMAGE_REQUEST_TOKEN: TOKEN,
        VEHICLE_IMAGE_MARKET_REGION: 'UZ',
        VEHICLE_IMAGE_REQUEST_TIMEOUT_MS: '50',
      }),
    ).toThrow(/TIMEOUT/);
  });

  it('runs disabled when the configuration is incomplete', () => {
    expect(
      readVehicleImageConfig(get({ VEHICLE_IMAGES_ENABLED: 'true' })).enabled,
    ).toBe(false);
    expect(
      readVehicleImageConfig(
        get({
          VEHICLE_IMAGES_ENABLED: 'TRUE',
          VEHICLE_IMAGE_PIPELINE_URL: 'https://x.test',
          VEHICLE_IMAGE_REQUEST_TOKEN: TOKEN,
          VEHICLE_IMAGE_MARKET_REGION: 'UZ',
        }),
      ).enabled,
    ).toBe(true);
  });

  it('never takes a global market: the retired VEHICLE_IMAGE_MARKET_REGION is ignored', () => {
    const env = {
      VEHICLE_IMAGES_ENABLED: 'true',
      VEHICLE_IMAGE_PIPELINE_URL: 'http://127.0.0.1:8047',
      VEHICLE_IMAGE_REQUEST_TOKEN: TOKEN,
    };
    expect(() => validateVehicleImageEnv(env)).not.toThrow();
    expect(readVehicleImageConfig(get(env)).enabled).toBe(true);
    // A leftover value (old deployments) neither blocks boot nor reaches the config.
    for (const leftover of ['UZ', 'uz', 'bogus']) {
      const withLeftover = { ...env, VEHICLE_IMAGE_MARKET_REGION: leftover };
      expect(() => validateVehicleImageEnv(withLeftover)).not.toThrow();
      const { config } = parseVehicleImageConfig(get(withLeftover));
      expect(config).not.toHaveProperty('marketRegion');
      expect(config.enabled).toBe(true);
    }
  });
});
