// The role each admin route demands, read from the real decorators through the real
// guard. What an operator may NOT do has to hold on the server for a direct API call,
// whatever the console shows, so this pins it at the route rather than in the UI.

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { AdminSourcingController } from '../sourcing/admin-sourcing.controller';
import { AdminRoleGuard } from './auth/guards/admin-role.guard';
import { AdminBrandsController } from './brands/admin-brands.controller';
import { AdminModelsController } from './brands/admin-models.controller';
import { AdminCategoriesController } from './categories/admin-categories.controller';
import { AdminProductsController } from './categories/admin-products.controller';
import { AdminDealersController } from './dealers/admin-dealers.controller';
import { AdminInventoryController } from './inventory/admin-inventory.controller';
import { AdminManagementController } from './management/admin-management.controller';
import { AdminPhotoCoverageController } from './photo-coverage/admin-photo-coverage.controller';
import { AdminRefundsController } from './refunds/admin-refunds.controller';

const guard = new AdminRoleGuard(new Reflector());

function allowed(
  controller: { prototype: object },
  method: string,
  role: AdminRole,
): boolean {
  const context = {
    getHandler: () =>
      (controller.prototype as Record<string, unknown>)[method] as () => void,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
}

const MANAGERS_ONLY: [string, { prototype: object }, string][] = [
  ['delete a category', AdminCategoriesController, 'remove'],
  ['preview a category transfer', AdminCategoriesController, 'transferPreview'],
  ['transfer a category', AdminCategoriesController, 'transfer'],
  ['delete a brand', AdminBrandsController, 'remove'],
  ['preview a brand delete', AdminBrandsController, 'deletePreview'],
  ['delete a model', AdminModelsController, 'remove'],
  ['preview a model delete', AdminModelsController, 'deletePreview'],
  ['delete a sourcing ticket', AdminSourcingController, 'remove'],
  ['issue a dealer API key', AdminDealersController, 'issueApiKey'],
  ['revoke a dealer API key', AdminDealersController, 'revokeApiKey'],
  ['record a refund', AdminRefundsController, 'record'],
  ['void a refund', AdminRefundsController, 'voidEntry'],
];

const EVERY_ROLE: [string, { prototype: object }, string][] = [
  ['read the category tree', AdminCategoriesController, 'tree'],
  ['edit a category', AdminCategoriesController, 'update'],
  ['deactivate a category', AdminCategoriesController, 'deactivate'],
  ['activate a category', AdminCategoriesController, 'activate'],
  ['edit a brand', AdminBrandsController, 'update'],
  ['edit a model', AdminModelsController, 'update'],
  ['move products', AdminProductsController, 'bulkMove'],
  ['edit inventory', AdminInventoryController, 'batchUpdate'],
  ['read photo coverage totals', AdminPhotoCoverageController, 'summary'],
  ['read the photo coverage list', AdminPhotoCoverageController, 'list'],
  ['read the refund registry', AdminRefundsController, 'list'],
  ["read an order's refunds", AdminRefundsController, 'forOrder'],
];

const SUPER_ADMIN_ONLY: [string, { prototype: object }, string][] = [
  ['create an administrator', AdminManagementController, 'create'],
  ['edit an administrator', AdminManagementController, 'update'],
  ['change a role', AdminManagementController, 'changeRole'],
  ['delete an administrator', AdminManagementController, 'remove'],
  ['read the audit trail', AdminManagementController, 'listAudit'],
];

describe('admin route permissions', () => {
  describe.each(MANAGERS_ONLY)('to %s', (_label, controller, method) => {
    it('an operator is refused', () => {
      expect(allowed(controller, method, AdminRole.OPERATOR)).toBe(false);
    });
    it('a manager and a super admin may', () => {
      expect(allowed(controller, method, AdminRole.MANAGER)).toBe(true);
      expect(allowed(controller, method, AdminRole.SUPER_ADMIN)).toBe(true);
    });
  });

  it.each(EVERY_ROLE)(
    'to %s, an operator is enough',
    (_label, controller, method) => {
      expect(allowed(controller, method, AdminRole.OPERATOR)).toBe(true);
    },
  );

  it.each(SUPER_ADMIN_ONLY)(
    'to %s, only a super admin',
    (_label, controller, method) => {
      expect(allowed(controller, method, AdminRole.SUPER_ADMIN)).toBe(true);
      expect(allowed(controller, method, AdminRole.MANAGER)).toBe(false);
      expect(allowed(controller, method, AdminRole.OPERATOR)).toBe(false);
    },
  );
});
