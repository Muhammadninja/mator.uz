import type {
  SeedReferenceModel,
  SourceRef,
  SourcedValue,
} from './seed-data/vehicle-reference.seed';
import { isVehicleBodyType, VEHICLE_BODY_TYPES } from './vehicle-body-types';

/**
 * Validation of the sourced facts a dataset model may carry (body type,
 * production years, availability pages). Pure; the planner calls it.
 *
 * The rule it enforces: no fact without a verifiable reference. A year or body
 * type with a missing, non-https or future-dated source is an error, and so is
 * a body type outside the controlled vocabulary.
 */

/** The pipeline identity accepts 1886–2200; a production year is never later than next year. */
const MIN_YEAR = 1886;
const MAX_PUBLISHER = 160;
const MAX_QUOTE = 400;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function sourceErrors(label: string, source: unknown, today: Date): string[] {
  if (!source || typeof source !== 'object') {
    return [`${label}: a source is required`];
  }
  const s = source as Partial<SourceRef>;
  const errors: string[] = [];
  let url: URL | null = null;
  try {
    url = typeof s.url === 'string' ? new URL(s.url) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || !url.hostname.includes('.')) {
    errors.push(`${label}: source url "${String(s.url)}" is not an https URL`);
  }
  const publisher = typeof s.publisher === 'string' ? s.publisher.trim() : '';
  if (!publisher || publisher.length > MAX_PUBLISHER) {
    errors.push(`${label}: source publisher is blank or too long`);
  }
  const quote = typeof s.quote === 'string' ? s.quote.trim() : '';
  if (!quote || quote.length > MAX_QUOTE) {
    errors.push(`${label}: source quote is blank or too long`);
  }
  const accessed =
    typeof s.accessedOn === 'string' && ISO_DATE.test(s.accessedOn)
      ? new Date(`${s.accessedOn}T00:00:00Z`)
      : null;
  if (
    !accessed ||
    Number.isNaN(accessed.getTime()) ||
    accessed.toISOString().slice(0, 10) !== s.accessedOn
  ) {
    errors.push(
      `${label}: source accessedOn "${String(s.accessedOn)}" is not a YYYY-MM-DD date`,
    );
  } else if (accessed.getTime() > today.getTime()) {
    errors.push(`${label}: source accessedOn ${s.accessedOn} is in the future`);
  }
  return errors;
}

function yearErrors(
  label: string,
  fact: SourcedValue<number> | undefined,
  today: Date,
): string[] {
  if (fact === undefined) return [];
  const maxYear = today.getUTCFullYear() + 1;
  const errors = sourceErrors(label, fact.source, today);
  if (
    !Number.isInteger(fact.value) ||
    fact.value < MIN_YEAR ||
    fact.value > maxYear
  ) {
    errors.push(
      `${label}: ${String(fact.value)} is not a year between ${MIN_YEAR} and ${maxYear}`,
    );
  }
  return errors;
}

/** Every problem with one model's facts; empty when it may be planned. */
export function modelFactErrors(
  model: SeedReferenceModel,
  opts: { requireAvailability: boolean; today: Date },
): string[] {
  const label = `model ${model.id}`;
  const errors: string[] = [];

  const availability = model.availability ?? [];
  if (opts.requireAvailability && availability.length === 0) {
    errors.push(
      `${label}: needs at least one official source showing it is offered in Uzbekistan`,
    );
  }
  availability.forEach((s, i) =>
    errors.push(...sourceErrors(`${label} availability[${i}]`, s, opts.today)),
  );

  if (model.bodyType !== undefined) {
    errors.push(
      ...sourceErrors(`${label} bodyType`, model.bodyType.source, opts.today),
    );
    if (!isVehicleBodyType(model.bodyType.value)) {
      errors.push(
        `${label}: body type "${String(model.bodyType.value)}" is not one of ${VEHICLE_BODY_TYPES.join(', ')}`,
      );
    }
  }

  errors.push(...yearErrors(`${label} yearFrom`, model.yearFrom, opts.today));
  errors.push(...yearErrors(`${label} yearTo`, model.yearTo, opts.today));
  if (
    model.yearFrom !== undefined &&
    model.yearTo !== undefined &&
    model.yearTo.value < model.yearFrom.value
  ) {
    errors.push(
      `${label}: yearTo ${model.yearTo.value} is before yearFrom ${model.yearFrom.value}`,
    );
  }
  return errors;
}

/** One line per source, for the dry-run report a reviewer checks. */
export function describeSources(model: SeedReferenceModel): string[] {
  const line = (what: string, s: SourceRef) =>
    `${what}: ${s.url} (${s.publisher}, read ${s.accessedOn}): ${s.quote}`;
  return [
    ...(model.availability ?? []).map((s) => line('offered', s)),
    ...(model.bodyType ? [line('body_type', model.bodyType.source)] : []),
    ...(model.yearFrom ? [line('year_from', model.yearFrom.source)] : []),
    ...(model.yearTo ? [line('year_to', model.yearTo.source)] : []),
  ];
}

/** The column values a NEW row gets: the sourced facts, or null. */
export function plannedFacts(model: SeedReferenceModel): {
  yearFrom: number | null;
  yearTo: number | null;
  bodyType: string | null;
} {
  return {
    yearFrom: model.yearFrom?.value ?? null,
    yearTo: model.yearTo?.value ?? null,
    bodyType: model.bodyType?.value ?? null,
  };
}
