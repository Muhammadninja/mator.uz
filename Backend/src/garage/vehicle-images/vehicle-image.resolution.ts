import {
  approvedCatalogAsset,
  catalogIdentityFacts,
  VEHICLE_IMAGE_CATALOG,
  type CatalogAsset,
} from './vehicle-image.catalog';
import {
  IMAGE_REVIEW_REASONS,
  planVehicleIdentity,
  type IdentityPlan,
  type ImageReviewReason,
  type VehicleIdentitySource,
} from './vehicle-image.identity';

/**
 * A Garage vehicle's identity and image plan, from catalog rows and the verified
 * vehicle image registry only. Pure; the caller reads the rows.
 *
 *   1. Catalog checks (planVehicleIdentity): missing or contradicting rows, or a
 *      year outside the model's stated range → review.
 *   2. Market, generation and facelift from identity-verified registry entries
 *      (catalogIdentityFacts):
 *        verified     → a market-verified identity
 *        unverified   → an UNVERIFIED identity: no market, nothing guessed. It
 *                       may enter reviewed acquisition, and nothing is published
 *                       for it without a person confirming the car
 *        ambiguous    → review `catalog_ambiguous`
 *        rejected     → review `catalog_image_rejected`
 *   3. Image: for a verified identity, the approved registry image, exact before
 *      compatible (approvedCatalogAsset). Without one, the plan is a pipeline
 *      request.
 *
 * A review plan never reaches the pipeline. An unverified plan reaches it, but
 * only as a request for candidates that a person must check.
 */
export function planVehicleImage(
  src: Omit<VehicleIdentitySource, 'marketRegion' | 'unverified'>,
  catalog: readonly CatalogAsset[] = VEHICLE_IMAGE_CATALOG,
): IdentityPlan {
  const review = (reason: ImageReviewReason): IdentityPlan => ({
    kind: 'review',
    reason,
  });
  const facts =
    src.make && src.model
      ? catalogIdentityFacts(
          {
            makeId: src.make.id,
            modelId: src.model.id,
            year: src.year,
            trimId: src.trim?.id ?? null,
          },
          catalog,
        )
      : ({ status: 'unverified' } as const);
  if (facts.status === 'ambiguous' || facts.status === 'rejected') {
    const plan = planVehicleIdentity(src);
    if (plan.kind === 'review') return plan;
    return review(
      facts.status === 'ambiguous'
        ? IMAGE_REVIEW_REASONS.CATALOG_AMBIGUOUS
        : IMAGE_REVIEW_REASONS.CATALOG_IMAGE_REJECTED,
    );
  }
  if (facts.status === 'unverified') {
    const plan = planVehicleIdentity({ ...src, unverified: true });
    if (plan.kind === 'review') return plan;
    return {
      ...plan,
      verification: 'unverified',
      resolved: {
        modelId: plan.identity.modelId,
        generationId: null,
        faceliftId: null,
        marketRegion: null,
      },
      catalogAsset: null,
    };
  }

  const plan = planVehicleIdentity({ ...src, marketRegion: facts.marketRegion });
  if (plan.kind === 'review') return plan;
  const { identity } = plan;
  const asset = approvedCatalogAsset(
    {
      makeId: identity.makeId,
      modelId: identity.modelId,
      year: identity.modelYear,
      trimId: identity.trimId,
      marketRegion: facts.marketRegion,
    },
    catalog,
  );
  if (asset === 'ambiguous')
    return review(IMAGE_REVIEW_REASONS.CATALOG_AMBIGUOUS);
  return {
    ...plan,
    verification: 'verified',
    resolved: {
      modelId: identity.modelId,
      generationId: facts.generationId,
      faceliftId: facts.faceliftId,
      marketRegion: facts.marketRegion,
    },
    catalogAsset: asset,
  };
}
