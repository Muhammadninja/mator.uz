import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like {@link JwtAuthGuard}, but never rejects the request.
 *
 * A valid bearer populates `req.user` (verified AppUser); a missing, expired,
 * revoked, or malformed token simply leaves `req.user` undefined and the
 * request proceeds anonymously. For public endpoints that personalize when a
 * user is known (e.g. the AI-chat sourcing route ties a ticket to the
 * authenticated customer) but must still serve anonymous callers.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Default handleRequest throws when there's no user; here we swallow the error
  // and hand back null so the route runs either way.
  handleRequest<TUser = unknown>(
    _err: unknown,
    user: TUser,
    _info?: unknown,
    _context?: ExecutionContext,
  ): TUser | null {
    return (user as TUser) ?? null;
  }
}

/**
 * {@link OptionalJwtAuthGuard}, run only when the request names a garage
 * vehicle (`?vehicle_id=`). The public catalogue reads it guards stay free of
 * token verification and the per-request user lookup when no vehicle is
 * involved, while a `vehicle_id` can only ever resolve for the caller who owns
 * that vehicle. Without the parameter `req.user` stays unset, exactly as for
 * an anonymous caller.
 */
@Injectable()
export class OptionalJwtForVehicleGuard extends OptionalJwtAuthGuard {
  canActivate(context: ExecutionContext) {
    const req = context
      .switchToHttp()
      .getRequest<{ query?: Record<string, unknown> }>();
    if (!req.query?.vehicle_id) return true;
    return super.canActivate(context);
  }
}

/**
 * No token means a guest. A token that fails is NOT a guest: this customer thinks
 * they're signed in, so answer 401 and let the app refresh it, instead of quietly
 * treating them as anonymous.
 */
@Injectable()
export class JwtUnlessAnonymousGuard extends OptionalJwtAuthGuard {
  handleRequest<TUser = unknown>(
    _err: unknown,
    user: TUser,
    _info?: unknown,
    context?: ExecutionContext,
  ): TUser | null {
    if (user) return user;
    const req = context
      ?.switchToHttp()
      .getRequest<{ headers?: Record<string, unknown> }>();
    if (req?.headers?.authorization) throw new UnauthorizedException();
    return null;
  }
}
