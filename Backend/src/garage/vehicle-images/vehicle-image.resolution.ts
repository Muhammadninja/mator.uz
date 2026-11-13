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
 *   1. Catalog checks (planVehicleIdentity): missing or contradicting rows,
 *      a model name another model of the make shares, a year outside the
 *      model's stated range → review.
 *   2. Market, generation and facelift from identity-verified registry
 *      entries (catalogIdentityFacts). None covers the vehicle → review
 *      `market_unverified`; entries disagree → `catalog_ambiguous`; the
 *      covering image was rejected → `catalog_image_rejected`.
 *   3. Image: the approved registry image, exact before compatible
 *      (approvedCatalogAsset). Without one, the plan is a pipeline request,
 *      which the pipeline answers with an approved publication or, when
 *      generation is enabled there, a generation job.
 *
 * A review plan never reaches the pipeline: an identity that could be more than
 * one vehicle keeps the placeholder and is never generated.
 */
export function planVehicleImage(
  src: Omit<VehicleIdentitySource, 'marketRegion'>,
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
  const plan = planVehicleIdentity({
    ...src,
    marketRegion: facts.status === 'verified' ? facts.marketRegion : null,
  });
  if (plan.kind === 'review') return plan;
  if (facts.status === 'ambiguous')
    return review(IMAGE_REVIEW_REASONS.CATALOG_AMBIGUOUS);
  if (facts.status === 'rejected')
    return review(IMAGE_REVIEW_REASONS.CATALOG_IMAGE_REJECTED);
  if (facts.status === 'unverified')
    return review(IMAGE_REVIEW_REASONS.MARKET_UNVERIFIED);

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
    resolved: {
      modelId: identity.modelId,
      generationId: facts.generationId,
      faceliftId: facts.faceliftId,
      marketRegion: facts.marketRegion,
    },
    catalogAsset: asset,
  };
}
