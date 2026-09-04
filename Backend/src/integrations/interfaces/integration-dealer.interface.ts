import type { Request } from 'express';

/**
 * The dealer behind an authenticated X-API-KEY, as resolved by
 * {@link ApiKeyGuard} and attached to the request.
 *
 * Deliberately narrow: the guard selects these four columns and nothing else,
 * so no unrelated dealer field (contact details, fiscal identity, GMV) is
 * carried around on the request object where a handler could leak it into a
 * response by accident.
 */
export interface IntegrationDealer {
  id: string;
  name: string;
  status: string;
  apiKeyLast4: string | null;
}

/**
 * Express request after ApiKeyGuard has run. `dealer` is present on every
 * handler the guard protects — the guard throws rather than passing an
 * unauthenticated request through, so it is not optional downstream.
 *
 * Named `dealer`, NOT `user`: the app-user JWT strategy owns `request.user`,
 * and an integration caller is not a user. Keeping the two on separate
 * properties means no user-scoped guard, decorator or interceptor can ever
 * mistake an API-key caller for a signed-in person.
 */
export type RequestWithDealer = Request & { dealer: IntegrationDealer };
