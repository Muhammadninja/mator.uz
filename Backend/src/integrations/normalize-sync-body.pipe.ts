import { Injectable, PipeTransform } from '@nestjs/common';

/**
 * Accepts the two shapes 1C exports actually POST and normalizes them to one.
 *
 *   [ {...}, {...} ]        →  { items: [ {...}, {...} ] }
 *   { items: [ … ], … }     →  unchanged
 *
 * Runs BEFORE the DTO's ValidationPipe (it is listed first in the handler's
 * pipe chain), so a bare-array upload is validated by exactly the same schema,
 * with the same whitelist and the same per-item rules, as a wrapped one. Doing
 * it here rather than by loosening the DTO keeps one schema and one contract:
 * the endpoint has a single documented body shape, and this pipe is only an
 * adapter for a client that cannot produce it.
 *
 * Anything that is neither an array nor an object is passed through untouched,
 * so a malformed body still fails validation with the normal 400 rather than
 * being reshaped into something that accidentally validates.
 */
@Injectable()
export class NormalizeSyncBodyPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (Array.isArray(value)) return { items: value };
    return value;
  }
}
