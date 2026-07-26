import { SetMetadata } from '@nestjs/common';
import { AdminRole } from '@prisma/client';

export const ADMIN_ROLES_KEY = 'admin_roles';

/**
 * Restrict a route (or a whole controller) to the given admin roles, enforced by
 * AdminRoleGuard:
 *
 *   @Roles(AdminRole.SUPER_ADMIN)
 *   @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
 *
 * Typed to AdminRole, so a typo is a compile error rather than a route that
 * silently admits nobody. Distinct metadata key from the user-side
 * `@Roles` (auth/decorators/roles.decorator.ts) — the two guards must never read
 * each other's metadata.
 */
export const Roles = (...roles: AdminRole[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
