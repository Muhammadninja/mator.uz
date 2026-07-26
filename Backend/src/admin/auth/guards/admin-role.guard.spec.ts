// Unit tests for AdminRoleGuard + the @Roles decorator. A real Reflector is used
// against really-decorated classes, so the metadata key wiring is exercised
// rather than assumed. Focus: single and multi-role gates, the deny path, the
// open-by-default route, and fail-closed behaviour when no admin is on the
// request (guard order wrong / AdminJwtGuard missing).

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { Roles } from '../decorators/roles.decorator';
import { AdminRoleGuard } from './admin-role.guard';

class SuperAdminOnlyController {
  @Roles(AdminRole.SUPER_ADMIN)
  handler() {}
}

class SuperAdminOrManagerController {
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  handler() {}
}

class UngatedController {
  handler() {}
}

/** Minimal ExecutionContext double pointing at a real decorated method. */
function contextFor(
  target: { new (): { handler: () => void } },
  user: { role: AdminRole } | undefined,
): ExecutionContext {
  const instance = new target();
  return {
    getHandler: () => instance.handler,
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AdminRoleGuard', () => {
  const guard = new AdminRoleGuard(new Reflector());

  it('allows the exact required role', () => {
    const ctx = contextFor(SuperAdminOnlyController, {
      role: AdminRole.SUPER_ADMIN,
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies a role that is not listed', () => {
    for (const role of [AdminRole.MANAGER, AdminRole.OPERATOR]) {
      const ctx = contextFor(SuperAdminOnlyController, { role });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    }
  });

  it('allows any of several listed roles', () => {
    for (const role of [AdminRole.SUPER_ADMIN, AdminRole.MANAGER]) {
      const ctx = contextFor(SuperAdminOrManagerController, { role });
      expect(guard.canActivate(ctx)).toBe(true);
    }
    const denied = contextFor(SuperAdminOrManagerController, {
      role: AdminRole.OPERATOR,
    });
    expect(() => guard.canActivate(denied)).toThrow(ForbiddenException);
  });

  it('lets any authenticated admin through a route with no @Roles', () => {
    const ctx = contextFor(UngatedController, { role: AdminRole.OPERATOR });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('fails closed when the request carries no admin', () => {
    // Wrong guard order or a missing AdminJwtGuard must deny, never allow.
    const ctx = contextFor(SuperAdminOnlyController, undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
