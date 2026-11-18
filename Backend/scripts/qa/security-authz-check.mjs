#!/usr/bin/env node
/**
 * Authorization verification for the release security gate (audit 2026-11-17,
 * gates 1, 2 and 6): BOLA/IDOR between two customers, customer → admin
 * function access, anonymous access, and unsigned payment webhooks.
 *
 * Staging only for anything that writes. Customer A creates an address, a
 * Garage vehicle, a favorite and a cart line, customer B attacks each by id,
 * and A removes them again. Against production (api.mator.uz) the script runs
 * only its read-only checks, and only with ALLOW_PROD_READONLY=1.
 *
 *   MATOR_API_BASE=https://api.staging.mator.uz \
 *   CUSTOMER_A_TOKEN=… CUSTOMER_B_TOKEN=… [ADMIN_TOKEN=…] \
 *   node scripts/qa/security-authz-check.mjs > authz-report.json
 *
 * Tokens are access tokens of dedicated test accounts. They are never printed.
 * Exit code 1 when any check fails.
 */

const base = (process.env.MATOR_API_BASE ?? '').replace(/\/+$/, '');
const A = process.env.CUSTOMER_A_TOKEN ?? '';
const B = process.env.CUSTOMER_B_TOKEN ?? '';
const ADMIN = process.env.ADMIN_TOKEN ?? '';
if (!base) throw new Error('MATOR_API_BASE is required');
const isProd = /^https:\/\/(api\.)?mator\.uz$/i.test(base);
if (isProd && process.env.ALLOW_PROD_READONLY !== '1') {
  throw new Error('Refusing production. Set ALLOW_PROD_READONLY=1 for read-only checks only.');
}
const writes = !isProd;

const results = [];
const created = [];

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text.slice(0, 200);
  }
  return { status: res.status, data };
}

function record(gate, name, ok, detail) {
  results.push({ gate, name, ok, ...detail });
}

/** A request another principal must not be able to make. */
async function expectDenied(gate, name, method, path, token, body) {
  const { status } = await call(method, path, token, body);
  record(gate, name, [401, 403, 404].includes(status), { method, path, status, expected: '401/403/404' });
}

async function expectStatus(gate, name, method, path, token, expected, body) {
  const { status, data } = await call(method, path, token, body);
  record(gate, name, expected.includes(status), { method, path, status, expected: expected.join('/') });
  return data;
}

const idOf = (data) => data?.id ?? data?.data?.id ?? data?.item?.id ?? data?.vehicle?.id ?? null;

async function anonymousChecks() {
  for (const [method, path] of [
    ['GET', '/v1/me'],
    ['GET', '/v1/orders'],
    ['GET', '/v1/cart'],
    ['GET', '/v1/account/addresses'],
    ['GET', '/v1/me/favorites'],
    ['GET', '/v1/garage/vehicles'],
    ['GET', '/v1/notifications'],
    ['GET', '/v1/admin/orders'],
    ['GET', '/v1/admins'],
    ['GET', '/v1/admin/users'],
  ]) {
    await expectStatus('anonymous', `no token → ${path}`, method, path, '', [401, 403]);
  }
}

async function webhookChecks() {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'CheckPerformTransaction', params: {} };
  const { data } = await call('POST', '/v1/payments/payme/webhook', '', rpc);
  record('webhooks', 'Payme without Basic auth is refused', data?.error?.code === -32504, { got: data?.error?.code });
  const forged = Buffer.from('Paycom:not-the-key').toString('base64');
  const res = await fetch(base + '/v1/payments/payme/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${forged}` },
    body: JSON.stringify(rpc),
  });
  const body = await res.json().catch(() => null);
  record('webhooks', 'Payme with a wrong key is refused', body?.error?.code === -32504, { got: body?.error?.code });
  const click = await call('POST', '/v1/payments/click/webhook', '', {
    action: 0, click_trans_id: '1', service_id: '1', merchant_trans_id: 'x', amount: '1', sign_time: 'x', sign_string: 'x',
  });
  record('webhooks', 'Click with a forged signature is refused', Number(click.data?.error) < 0, { got: click.data?.error });
}

async function functionLevelChecks(token, who) {
  for (const [method, path, body] of [
    ['GET', '/v1/admin/orders'],
    ['GET', '/v1/admin/users'],
    ['GET', '/v1/admins'],
    ['GET', '/v1/admin/finance/sellers'],
    ['GET', '/v1/admin/refunds'],
    ['PATCH', '/v1/orders/ord_nonexistent/status', { status: 'delivered' }],
    ['POST', '/v1/admin/inventory/batch-delete', { ids: [] }],
    ['POST', '/v1/admin/refunds/orders/ord_nonexistent', {}],
  ]) {
    await expectStatus('function-authz', `${who} → ${method} ${path}`, method, path, token, [401, 403], body);
  }
}

async function bolaChecks() {
  const me = await expectStatus('setup', 'customer A /v1/me', 'GET', '/v1/me', A, [200]);
  const meB = await expectStatus('setup', 'customer B /v1/me', 'GET', '/v1/me', B, [200]);
  const aId = me?.id ?? me?.data?.id;
  const bId = meB?.id ?? meB?.data?.id;
  record('setup', 'A and B are different accounts', Boolean(aId && bId && aId !== bId), {});

  // Existing objects of A that B must not reach.
  const orders = await call('GET', '/v1/orders', A);
  const order = orders.data?.items?.[0];
  if (order) {
    const orderId = order.order_id ?? order.id;
    await expectDenied('bola', 'B reads A’s order', 'GET', `/v1/orders/${orderId}`, B);
    if (order.payment_id) {
      await expectDenied('bola', 'B reads A’s payment', 'GET', `/v1/payments/${order.payment_id}`, B);
    }
    const listB = await call('GET', '/v1/orders', B);
    const leaked = (listB.data?.items ?? []).some((o) => (o.order_id ?? o.id) === orderId);
    record('bola', 'A’s order absent from B’s list', !leaked, {});
  } else {
    record('bola', 'A has an order to test against', false, { note: 'place one staging order as A, then rerun' });
  }

  if (!writes) return;

  const address = await expectStatus('setup', 'A creates an address', 'POST', '/v1/addresses', A, [200, 201], {
    full_text: 'Security test address', label: 'authz-test', lat: 41.3111, lng: 69.2797,
  });
  const addressId = idOf(address);
  if (addressId) {
    created.push(['DELETE', `/v1/addresses/${addressId}`]);
    await expectDenied('bola', 'B edits A’s address', 'PATCH', `/v1/addresses/${addressId}`, B, { label: 'pwned' });
    await expectDenied('bola', 'B deletes A’s address', 'DELETE', `/v1/addresses/${addressId}`, B);
    const listB = await call('GET', '/v1/account/addresses', B);
    record('bola', 'A’s address absent from B’s list',
      !(listB.data?.items ?? []).some((x) => x.id === addressId), {});
  }

  const vehicle = await expectStatus('setup', 'A adds a Garage vehicle', 'POST', '/v1/garage/vehicles', A, [200, 201], {
    custom_make_name: 'AuthzTest', custom_model_name: 'Probe', year: 2015,
  });
  const vehicleId = idOf(vehicle);
  if (vehicleId) {
    created.push(['DELETE', `/v1/garage/vehicles/${vehicleId}`]);
    await expectDenied('bola', 'B reads A’s vehicle', 'GET', `/v1/garage/vehicles/${vehicleId}`, B);
    await expectDenied('bola', 'B edits A’s vehicle', 'PATCH', `/v1/garage/vehicles/${vehicleId}`, B, { nickname: 'pwned' });
    await expectDenied('bola', 'B sets A’s vehicle primary', 'POST', `/v1/garage/vehicles/${vehicleId}/set-primary`, B);
    await expectDenied('bola', 'B deletes A’s vehicle', 'DELETE', `/v1/garage/vehicles/${vehicleId}`, B);
  }

  const parts = await call('GET', '/v1/catalog/parts', '');
  const partId = parts.data?.items?.find((p) => p.in_stock !== false)?.id ?? parts.data?.items?.[0]?.id;
  if (partId) {
    await expectStatus('setup', 'A favorites a part', 'PUT', `/v1/me/favorites/${partId}`, A, [200, 201, 204]);
    created.push(['DELETE', `/v1/me/favorites/${partId}`]);
    const favB = await call('GET', '/v1/me/favorites', B);
    const favItems = favB.data?.items ?? favB.data ?? [];
    record('bola', 'A’s favorite absent from B’s list',
      !(Array.isArray(favItems) && favItems.some((f) => (f.part_id ?? f.id) === partId)), {});

    const cart = await expectStatus('setup', 'A adds a cart line', 'POST', '/v1/cart/items', A, [200, 201], {
      part_id: partId, quantity: 1,
    });
    const line = (cart?.items ?? []).find((i) => (i.part_id ?? i.partId ?? i.id) === partId) ?? cart?.items?.[0];
    if (line?.id) {
      created.push(['DELETE', `/v1/cart/items/${line.id}`]);
      await expectDenied('bola', 'B changes A’s cart line', 'PATCH', `/v1/cart/items/${line.id}`, B, { quantity: 99 });
      await expectDenied('bola', 'B removes A’s cart line', 'DELETE', `/v1/cart/items/${line.id}`, B);
      const cartB = await call('GET', '/v1/cart', B);
      record('bola', 'A’s cart line absent from B’s cart',
        !(cartB.data?.items ?? []).some((i) => i.id === line.id), {});
    }
  }
}

async function cleanup() {
  for (const [method, path] of created.reverse()) {
    const { status } = await call(method, path, A).catch(() => ({ status: 0 }));
    results.push({ gate: 'cleanup', name: `${method} ${path}`, ok: status < 400, status });
  }
}

try {
  await anonymousChecks();
  await webhookChecks();
  if (A && B) {
    await functionLevelChecks(A, 'customer');
    await bolaChecks();
  } else {
    record('setup', 'customer tokens provided', false, { note: 'CUSTOMER_A_TOKEN and CUSTOMER_B_TOKEN are required' });
  }
  if (ADMIN) {
    await expectStatus('function-authz', 'admin positive control → /v1/admin/orders', 'GET', '/v1/admin/orders', ADMIN, [200]);
  }
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ base, mode: writes ? 'staging' : 'prod-readonly', at: new Date().toISOString(),
  passed: results.length - failed.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
