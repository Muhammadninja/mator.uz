import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Where the BFL API key may be sent, and how provider-returned URLs are fetched
 * (INFO-12).
 *
 * BFL answers a submit with a `polling_url` that is then polled WITH the API
 * key. That URL is data from a response, so before the key goes with it:
 *
 *   • it must be https, with no credentials and the default port;
 *   • its host must be BFL's API: `api.bfl.ai` or a regional `api.<region>.bfl.ai`
 *     (BFL routes jobs to regional clusters, e.g. `api.us1.bfl.ai`), or a host
 *     listed in BFL_POLLING_ALLOWED_HOSTS. An IP literal never matches;
 *   • no redirect is followed. axios' redirect handling strips `Authorization`
 *     on a cross-host hop but not a custom `x-key` header, so following one
 *     could hand the key to wherever the redirect points.
 *
 * Every connection to a provider-returned URL (polling and the result download)
 * also resolves through {@link publicOnlyLookup}, which refuses loopback,
 * private, link-local and other non-public addresses, so a URL cannot be aimed
 * at this machine or the internal network.
 */
const BFL_API_HOST = /^api(\.[a-z]{2}\d{0,2})?\.bfl\.ai$/;

function extraHosts(): string[] {
  return (process.env.BFL_POLLING_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Why the key may not go to `raw`, or null when it may. */
export function pollingUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (url.username || url.password) return 'credentials in URL';
  if (url.port !== '') return 'non-default port';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return 'IP address host';
  if (BFL_API_HOST.test(host) || extraHosts().includes(host)) return null;
  return 'host not trusted';
}

/** Why `raw` may not be downloaded (no key is sent there), or null. */
export function downloadUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (url.username || url.password) return 'credentials in URL';
  return null;
}

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(raw: string): boolean {
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  const address = mapped ? mapped[1] : raw;
  const kind = isIP(address);
  if (kind === 0) return false;
  return !NON_PUBLIC.check(address, kind === 6 ? 'ipv6' : 'ipv4');
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `dns.lookup` that refuses to connect anywhere but a public address. The check
 * runs on the address actually connected to, so a name that resolves (or later
 * re-resolves) to an internal address is refused.
 */
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean } | number | undefined,
  callback: LookupCallback,
): void {
  const opts = typeof options === 'object' && options ? options : {};
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err, opts.all ? [] : '', undefined);
    const list = addresses;
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (list.length === 0 || bad) {
      const refused = Object.assign(
        new Error(`refusing to connect to non-public address for ${hostname}`),
        { code: 'ENONPUBLIC' },
      );
      return callback(refused, opts.all ? [] : '', undefined);
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** Agent for every request to a provider-returned URL. */
export const providerUrlAgent = new Agent({
  keepAlive: true,
  lookup: publicOnlyLookup,
});
