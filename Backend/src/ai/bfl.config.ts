/**
 * Black Forest Labs (BFL) configuration for the seller image pipeline.
 *
 *   • BFL_API_KEY    — required. Sent only as the `x-key` header to BFL's API;
 *                      never logged, never part of an error message.
 *   • BFL_FLUX_MODEL — optional, defaults to `flux-3-image`. The path segment of
 *                      BFL's per-model endpoint, `https://api.bfl.ai/v1/<model>`.
 *
 * The model is configurable, but only to a model whose REQUEST CONTRACT
 * ImageEnhanceService implements. FLUX 3 Image takes `images` / `aspect_ratio` /
 * `resolution`; FLUX.2 [pro] took `input_image` / `width` / `height`. Pointing
 * this client at an endpoint with a different contract would at best be rejected
 * (422) and at worst ignore the seller's photo and generate a part from the
 * prompt alone — so an unsupported value is a hard error, never a fallback.
 *
 * Resolved by ImageEnhanceService's constructor, i.e. while Nest builds the
 * providers: a bad value aborts bootstrap exactly as a missing key always has.
 */

/** BFL's global endpoint (automatic failover across BFL's clusters). */
export const BFL_API_BASE_URL = 'https://api.bfl.ai/v1';

/** Models whose request contract ImageEnhanceService speaks. */
export const SUPPORTED_BFL_FLUX_MODELS = ['flux-3-image'] as const;

export type BflFluxModel = (typeof SUPPORTED_BFL_FLUX_MODELS)[number];

/** Used when BFL_FLUX_MODEL is unset or blank. */
export const DEFAULT_BFL_FLUX_MODEL: BflFluxModel = 'flux-3-image';

export interface BflConfig {
  apiKey: string;
  model: BflFluxModel;
  /** Submit endpoint: `${BFL_API_BASE_URL}/${model}`. */
  endpoint: string;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSupportedModel(value: string): value is BflFluxModel {
  return (SUPPORTED_BFL_FLUX_MODELS as readonly string[]).includes(value);
}

/** Every BFL misconfiguration, as human-readable lines (empty = valid). */
export function collectBflConfigErrors(env: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!asTrimmedString(env.BFL_API_KEY)) {
    errors.push('BFL_API_KEY is not set');
  }
  const model = asTrimmedString(env.BFL_FLUX_MODEL);
  if (model && !isSupportedModel(model)) {
    errors.push(
      `BFL_FLUX_MODEL="${model}" is not supported: this client implements the ` +
        `FLUX 3 Image request contract (supported: ${SUPPORTED_BFL_FLUX_MODELS.join(', ')})`,
    );
  }
  return errors;
}

/** Read the BFL settings, throwing on any misconfiguration. */
export function resolveBflConfig(env: Record<string, unknown>): BflConfig {
  const errors = collectBflConfigErrors(env);
  if (errors.length > 0) {
    throw new Error(`Invalid BFL configuration: ${errors.join('; ')}`);
  }
  const configured = asTrimmedString(env.BFL_FLUX_MODEL);
  const model = isSupportedModel(configured)
    ? configured
    : DEFAULT_BFL_FLUX_MODEL;
  return {
    apiKey: asTrimmedString(env.BFL_API_KEY),
    model,
    endpoint: `${BFL_API_BASE_URL}/${model}`,
  };
}
