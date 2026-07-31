/**
 * Payme sandbox fixture: the minimum data test.paycom.uz needs to exercise the
 * Merchant API against this backend.
 *
 *   npm run payme:fixture
 *   npm run payme:fixture -- --amount=215000
 *   npm run payme:fixture -- --reset      # return the order to a fresh unpaid state
 *
 * WHY SO LITTLE DATA: the Payme webhook resolves a payment by
 * `params.account.<field>` → `order.findUnique` → amount check → status check.
 * It never reads order items, the cart, an address or a vehicle, so none of those
 * are created — a fixture that invented a product/cart/line-item chain would be
 * fabricating business records that no part of the flow consults.
 *
 * Only two rows are therefore written:
 *   • AppUser — required solely because Order.userId is a non-null FK
 *     (onDelete: Restrict). Every other AppUser column is nullable or defaulted.
 *   • Order   — required columns are userId, subtotalUzs and totalUzs; `status`
 *     defaults to PENDING_PAYMENT and `expiresAt` is set explicitly so the
 *     sweeper does not expire the fixture mid-test.
 *
 * NOT part of `prisma db seed`: the seed stays reference-data only, and test
 * payment fixtures must never be created implicitly on a real environment.
 *
 * Idempotent — fixed ids, upserted. Re-running converges instead of piling up
 * users and orders.
 */
import { OrderStatus, PrismaClient, Role } from '@prisma/client';
import { buildPaymeCheckoutUrl } from '../src/orders/webhooks/payme-checkout.util';
import { readPaymeConfig } from '../src/orders/webhooks/payme.config';

const prisma = new PrismaClient();

/**
 * Stable, unmistakably-test identifiers so the rows are easy to spot and the
 * script converges on re-run. AppUser.id is a uuid column, so the user id has to
 * be a real uuid rather than a descriptive slug — the display name carries the
 * "this is a test account" signal instead.
 */
const TEST_USER_ID = '00000000-0000-4000-8000-000000000001';
const TEST_ORDER_ID = 'payme-sandbox-test-order';
const TEST_USER_LABEL = 'Payme Sandbox Test User';

/** Default order total, in whole UZS. Payme is quoted this × 100, in tiyin. */
const DEFAULT_TOTAL_UZS = 215_000;

/** How long the fixture order stays payable. Generous so a manual run cannot race the sweeper. */
const EXPIRY_HOURS = 24;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) args[body] = 'true';
    else args[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const totalUzs = Number(args.amount ?? DEFAULT_TOTAL_UZS);
  if (!Number.isFinite(totalUzs) || totalUzs <= 0) {
    throw new Error(
      `--amount must be a positive number of UZS (got "${args.amount}")`,
    );
  }
  // Payme quotes every amount in tiyin: 1 UZS = 100 tiyin. This must match the
  // webhook's own check (Math.round(totalUzs * 100)) exactly, or
  // CheckPerformTransaction answers -31001.
  const amountTiyin = Math.round(totalUzs * 100);
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 3_600_000);

  // AppUser: only `id` is required; everything else is nullable or defaulted.
  // No email, no password hash — this account cannot be logged into, which is
  // deliberate for a fixture.
  await prisma.appUser.upsert({
    where: { id: TEST_USER_ID },
    update: { displayName: TEST_USER_LABEL },
    create: { id: TEST_USER_ID, displayName: TEST_USER_LABEL, role: Role.USER },
  });

  // Order: userId + subtotalUzs + totalUzs are the only non-defaulted columns.
  // On re-run the order is returned to a payable state so the sandbox flow can be
  // repeated, but any payments already attached to it are left untouched.
  const order = await prisma.order.upsert({
    where: { id: TEST_ORDER_ID },
    update: {
      status: OrderStatus.PENDING_PAYMENT,
      subtotalUzs: totalUzs,
      totalUzs,
      expiresAt,
    },
    create: {
      id: TEST_ORDER_ID,
      userId: TEST_USER_ID,
      status: OrderStatus.PENDING_PAYMENT,
      subtotalUzs: totalUzs,
      totalUzs,
      expiresAt,
    },
  });

  // `--reset` clears prior Payme transactions so a repeat run starts clean.
  // Without it, an existing state-1 transaction would (correctly) make the next
  // CreateTransaction fail with "another transaction is in progress".
  if (args.reset) {
    const removed = await prisma.payment.deleteMany({
      where: { orderId: TEST_ORDER_ID },
    });
    console.log(
      `[fixture] --reset: removed ${removed.count} payment row(s) for this order`,
    );
  }

  const payme = readPaymeConfig((key) => process.env[key]);
  const accountField = payme.accountField;
  const checkoutUrl = payme.merchantId
    ? buildPaymeCheckoutUrl({
        merchantId: payme.merchantId,
        accountField,
        orderId: order.id,
        amountTiyin,
        checkoutBaseUrl: payme.checkoutUrl,
      })
    : null;

  const existingPayments = await prisma.payment.count({
    where: { orderId: TEST_ORDER_ID },
  });

  console.log('\n── Payme sandbox fixture ───────────────────────────────────');
  console.log(`  user id           ${TEST_USER_ID}`);
  console.log(`  order id          ${order.id}`);
  console.log(`  order status      ${order.status}`);
  console.log(
    `  totalUzs          ${Number(order.totalUzs).toLocaleString('en-US')} UZS`,
  );
  console.log(`  expiresAt         ${order.expiresAt?.toISOString()}`);
  console.log(`  account field     ${accountField}`);
  console.log(`  account value     { "${accountField}": "${order.id}" }`);
  console.log(`  amount (tiyin)    ${amountTiyin}`);
  console.log(`  existing payments ${existingPayments}`);
  console.log(
    `  checkout URL      ${checkoutUrl ?? '(PAYME_MERCHANT_ID not set — cannot build)'}`,
  );
  console.log('────────────────────────────────────────────────────────────');

  if (!checkoutUrl) {
    console.log(
      '\n  Set PAYME_MERCHANT_ID (and PAYME_MERCHANT_KEY) to generate the checkout link.\n' +
        '  Point PAYME_CHECKOUT_URL at https://test.paycom.uz for the sandbox.',
    );
  }
  if (existingPayments > 0 && !args.reset) {
    console.log(
      '\n  This order already has payment rows. Re-run with `-- --reset` to clear them\n' +
        '  before starting a fresh CreateTransaction.',
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
