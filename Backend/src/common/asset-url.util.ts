/**
 * Shared trusted-asset-URL policy. Every externally-referenced asset URL the
 * backend stores or forwards (user avatars, AI message image attachments) must
 * pass through here so the whole app enforces one policy:
 *   • the URL must be a valid absolute HTTPS URL, and
 *   • its host must be on the configured allowlist.
 *
 * The allowlist is read from the `ASSET_URL_ALLOWED_HOSTS` environment variable
 * (comma-separated hostnames), so the trusted CDN(s) can be changed — or a
 * provider swapped — without touching application code. Nothing is hardcoded.
 *
 * Matching is case-insensitive and covers exact host matches plus subdomains of
 * an allowlisted host (e.g. `res.cloudinary.com` is allowed when the allowlist
 * contains `cloudinary.com`).
 *
 * If the allowlist is empty/unset, no external host is trusted and every URL is
 * rejected (fail-closed).
 */

const ENV_KEY = 'ASSET_URL_ALLOWED_HOSTS';

/** Parse the comma-separated allowlist from the environment into lowercased hosts. */
export function getAllowedAssetHosts(): string[] {
  return (process.env[ENV_KEY] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when `value` is an absolute HTTPS URL whose host is exactly, or a
 * subdomain of, an allowlisted host. Fail-closed on parse errors, non-HTTPS
 * schemes, and an empty allowlist.
 */
export function isAllowedAssetUrl(value: unknown, allowedHosts: string[] = getAllowedAssetHosts()): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (allowedHosts.length === 0) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
