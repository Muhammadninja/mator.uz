// Guard composition on OrdersController.
//
// Regression pin for a real 401: the operator route PATCH /v1/orders/:id/status
// carried method-level @UseGuards(AdminJwtGuard, AdminRoleGuard) while the class
// carried @UseGuards(JwtAuthGuard). Nest guards are ADDITIVE — controller-level
// guards run BEFORE method-level ones and can only narrow access, never be
// replaced by them. So every admin token (HS256, aud `mator-admin-panel`) was
// rejected by the user strategy (RS256, aud `mator-app`) before AdminJwtGuard
// was ever consulted, and the endpoint was unreachable by design.
//
// These tests read the guard metadata Nest itself reads, so they fail if the
// class-level guard is ever reintroduced or a customer route loses its own.

import { GUARDS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { AdminJwtGuard } from '../admin/auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../admin/auth/guards/admin-role.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersController } from './orders.controller';

/** Guards Nest applies at the controller level (run first, on every route). */
function classGuards(): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, OrdersController) ??
    []) as unknown[];
}

/** Guards Nest applies to one handler (run after any class-level guards). */
function routeGuards(method: keyof OrdersController): unknown[] {
  return (Reflect.getMetadata(
    GUARDS_METADATA,
    OrdersController.prototype[method],
  ) ?? []) as unknown[];
}

describe('OrdersController guard composition', () => {
  it('declares NO class-level guard, so per-route auth is authoritative', () => {
    // The heart of the bug: any guard here also runs on the admin-only route.
    expect(classGuards()).toEqual([]);
  });

  it.each(['create', 'list', 'get'] as const)(
    'gates the customer route %s on the app-user token only',
    (method) => {
      const guards = routeGuards(method);
      expect(guards).toContain(JwtAuthGuard);
      // A customer route must not demand an admin token.
      expect(guards).not.toContain(AdminJwtGuard);
    },
  );

  it('gates the operator status write on an admin token, never a user token', () => {
    const guards = routeGuards('updateStatus');
    expect(guards).toEqual([AdminJwtGuard, AdminRoleGuard]);
    // If JwtAuthGuard reaches this route by any path, admin tokens 401 again.
    expect(guards).not.toContain(JwtAuthGuard);
  });

  it('never subjects the operator route to the user guard, class or method', () => {
    // The precise condition that produced the 401, stated end to end.
    const effective = [...classGuards(), ...routeGuards('updateStatus')];
    expect(effective).not.toContain(JwtAuthGuard);
    expect(effective).toContain(AdminJwtGuard);
  });
});
