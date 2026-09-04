import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type {
  IntegrationDealer,
  RequestWithDealer,
} from '../interfaces/integration-dealer.interface';

/**
 * Injects the dealer authenticated by {@link ApiKeyGuard}.
 *
 * Only valid on a handler the guard protects — the guard throws rather than
 * letting an unauthenticated request through, so the value is always present.
 * Using this instead of reading `@Req()` keeps handlers from touching the raw
 * request (and from ever seeing the header the credential arrived in).
 */
export const CurrentDealer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IntegrationDealer =>
    ctx.switchToHttp().getRequest<RequestWithDealer>().dealer,
);
