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
      },
      errors: [],
    });
    expect(() => validateVehicleImageEnv({})).not.toThrow();
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
        VEHICLE_IMAGE_PIPELINE_URL: 'https://u:p@x.test',
      }),
    ).toThrow(/credentials/);
    expect(() =>
      validateVehicleImageEnv({
        ...env,
        VEHICLE_IMAGE_REQUEST_TOKEN: TOKEN,
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
        }),
      ).enabled,
    ).toBe(true);
  });
});
