import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ADMIN_JWT_STRATEGY } from '../strategies/admin-jwt.strategy';

/**
 * Bearer-auth guard for admin-panel routes. Bound to the `admin-jwt` strategy,
 * so it accepts ONLY admin tokens — a mobile-app user token cannot pass it (and
 * JwtAuthGuard, which is bound to `jwt`, cannot be passed by an admin token).
 */
@Injectable()
export class AdminJwtGuard extends AuthGuard(ADMIN_JWT_STRATEGY) {}
