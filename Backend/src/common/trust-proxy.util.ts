/**
 * Express's `trust proxy` value. `loopback` matches the documented deployment, Nginx
 * on the same machine. TRUST_PROXY overrides it with a comma-separated list of
 * addresses or CIDR ranges when a proxy runs elsewhere. A blanket `true` or a hop
 * count is refused: either would let a direct client supply its own address.
 */
export function resolveTrustProxy(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return 'loopback';
  if (/^(true|\d+)$/i.test(value)) {
    throw new Error(
      'TRUST_PROXY must name trusted proxies (addresses or CIDR ranges), not "true" or a hop count',
    );
  }
  return value;
}
