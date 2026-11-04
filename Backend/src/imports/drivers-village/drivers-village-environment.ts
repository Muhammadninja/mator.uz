/**
 * The database setup every Driver's Village import needs before it may write:
 * the migrated schema, the catalog dealer and the BUSINESS supply-side seller
 * explicitly linked to it. Shared by the price/stock sync and the
 * classification import. Read-only.
 */
import { REQUIRED_MIGRATIONS } from './drivers-village.store';
import type {
  CatalogSellerRef,
  DriversVillageStore,
  LinkedSellerRef,
} from './drivers-village.store';
import type { ImportIssue } from './drivers-village.types';

export type EnvironmentStore = Pick<
  DriversVillageStore,
  'schemaReady' | 'findCatalogSeller' | 'findLinkedSeller'
>;

export interface EnvironmentCheck {
  schemaReady: boolean;
  catalogSeller: CatalogSellerRef | null;
  linked: LinkedSellerRef | null;
  /** File-level problems of THIS database (kind 'reference'). */
  issues: ImportIssue[];
}

const envIssue = (
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): ImportIssue => ({
  line: null,
  code1c: null,
  kind: 'reference',
  severity,
  code,
  field: null,
  message,
});

export async function checkEnvironment(
  store: EnvironmentStore,
  catalogSellerId: string,
): Promise<EnvironmentCheck> {
  const issues: ImportIssue[] = [];
  const schemaReady = await store.schemaReady();
  if (!schemaReady) {
    issues.push(
      envIssue(
        'schema_not_migrated',
        `This database does not have migrations ${REQUIRED_MIGRATIONS.join(' and ')} yet (run \`npx prisma migrate deploy\`). Existing positions cannot be read, so every valid row is planned as a create.`,
      ),
    );
  }
  const catalogSeller = await store.findCatalogSeller(catalogSellerId);
  if (!catalogSeller) {
    issues.push(
      envIssue(
        'catalog_seller_missing',
        `Catalog seller "${catalogSellerId}" does not exist in this database. The importer never creates it.`,
      ),
    );
  }
  const linked = schemaReady
    ? await store.findLinkedSeller(catalogSellerId)
    : null;
  if (!linked && schemaReady) {
    issues.push(
      envIssue(
        'linked_seller_missing',
        `Setup required: no supply-side seller is linked to catalog seller "${catalogSellerId}". ` +
          `Create the Driver's Village BUSINESS seller (tg_id NULL) with catalog_seller_id = "${catalogSellerId}" ` +
          `as described in docs/DRIVERS_VILLAGE_IMPORT.md §1. The importer never creates a seller.`,
      ),
    );
  }
  if (linked && linked.sellerType !== 'BUSINESS') {
    // Driver's Village is an organization fed by 1C, not a Telegram account.
    // A TELEGRAM seller linked here is a setup mistake (someone's bot account
    // would own the dealer's whole inventory), so it blocks the import.
    issues.push(
      envIssue(
        'linked_seller_not_business',
        `Seller #${linked.id} linked to "${catalogSellerId}" is a ${linked.sellerType} seller; ` +
          `the Driver's Village seller must be a BUSINESS seller (docs/DRIVERS_VILLAGE_IMPORT.md §1).`,
      ),
    );
  }
  if (linked && linked.status !== 'ACTIVE') {
    issues.push(
      envIssue(
        'linked_seller_not_active',
        `Seller #${linked.id} linked to "${catalogSellerId}" has status ${linked.status} (expected ACTIVE).`,
        'warning',
      ),
    );
  }
  return { schemaReady, catalogSeller, linked, issues };
}
