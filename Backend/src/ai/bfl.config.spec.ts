import {
  BFL_API_BASE_URL,
  DEFAULT_BFL_FLUX_MODEL,
  SUPPORTED_BFL_FLUX_MODELS,
  collectBflConfigErrors,
  resolveBflConfig,
} from './bfl.config';

/**
 * The image worker must run FLUX 3 Image with a real key, and must never be
 * pointed back at FLUX.2 [pro] by configuration: its request contract differs,
 * so it would reject the request or ignore the seller's photo.
 */
describe('BFL configuration', () => {
  const key = { BFL_API_KEY: 'bfl-secret' };

  it('defaults to FLUX 3 Image on the global endpoint', () => {
    expect(resolveBflConfig(key)).toEqual({
      apiKey: 'bfl-secret',
      model: 'flux-3-image',
      endpoint: 'https://api.bfl.ai/v1/flux-3-image',
    });
  });

  it('neither defaults to nor supports any FLUX.2 model', () => {
    expect(DEFAULT_BFL_FLUX_MODEL).toBe('flux-3-image');
    expect(SUPPORTED_BFL_FLUX_MODELS.some((m) => m.startsWith('flux-2'))).toBe(
      false,
    );
  });

  it('reads BFL_FLUX_MODEL, trimming whitespace', () => {
    const config = resolveBflConfig({
      ...key,
      BFL_FLUX_MODEL: '  flux-3-image\n',
    });
    expect(config.model).toBe('flux-3-image');
    expect(config.endpoint).toBe(`${BFL_API_BASE_URL}/flux-3-image`);
  });

  it('treats a blank BFL_FLUX_MODEL as unset', () => {
    expect(resolveBflConfig({ ...key, BFL_FLUX_MODEL: '  ' }).model).toBe(
      DEFAULT_BFL_FLUX_MODEL,
    );
  });

  it('trims the key', () => {
    expect(resolveBflConfig({ BFL_API_KEY: ' bfl-secret\n' }).apiKey).toBe(
      'bfl-secret',
    );
  });

  it.each([undefined, '', '   '])('requires BFL_API_KEY (got %p)', (value) => {
    expect(collectBflConfigErrors({ BFL_API_KEY: value })).toEqual([
      'BFL_API_KEY is not set',
    ]);
    expect(() => resolveBflConfig({ BFL_API_KEY: value })).toThrow(
      'BFL_API_KEY is not set',
    );
  });

  it.each([
    'flux-2-pro',
    'flux-2-pro-preview',
    'flux-2-max',
    'flux-kontext-pro',
    'flux-3-video',
    'FLUX-3-IMAGE',
  ])('refuses the unsupported model %s', (model) => {
    expect(() => resolveBflConfig({ ...key, BFL_FLUX_MODEL: model })).toThrow(
      `BFL_FLUX_MODEL="${model}" is not supported`,
    );
  });

  it('reports every problem at once', () => {
    const errors = collectBflConfigErrors({ BFL_FLUX_MODEL: 'flux-2-pro' });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe('BFL_API_KEY is not set');
    expect(errors[1]).toContain('supported: flux-3-image');
  });

  it('never echoes the key in a configuration error', () => {
    let message = '';
    try {
      resolveBflConfig({ ...key, BFL_FLUX_MODEL: 'flux-2-pro' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Invalid BFL configuration');
    expect(message).not.toContain('bfl-secret');
  });
});
