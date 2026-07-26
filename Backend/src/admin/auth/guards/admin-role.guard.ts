import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { ADMIN_ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedAdmin } from '../strategies/admin-jwt.strategy';

/**
 * Enforces `@Roles(...)` on admin routes. Always used AFTER AdminJwtGuard, which
 * is what puts the authenticated admin on the request:
 *
 *   @UseGuards(AdminJwtGuard, AdminRoleGuard)
 *
 * Fail-closed: a route that declares roles but has no authenticated admin on the
 * request (guard order wrong, guard missing) is rejected, never allowed through.
 * A route with no `@Roles(...)` is open to any authenticated admin.
 */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No role requirement declared -> any authenticated admin may proceed.
    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedAdmin }>();
    const admin = request.user;
    if (!admin?.role) {
      throw new ForbiddenException('Insufficient permissions');
    }
    if (!required.includes(admin.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
