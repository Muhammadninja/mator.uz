import { BadRequestException } from '@nestjs/common';

/**
 * Where a payment provider may send the buyer back to (LOW-PAY-009).
 *
 * `return_url` comes from the client and ends up inside the checkout link. For
 * Payme that link is a `;`-separated parameter list, so a `;` in the value
 * would add parameters of the sender's choosing, and an arbitrary https URL
 * would make our checkout link a redirect to anywhere. Neither changes what is
 * charged (the webhook re-validates the amount and the account), but both put
 * our name on someone else's destination.
 *
 * Accepted, and nothing else:
 *   • the app's own callback scheme (`mator://…`), plus the Expo development
 *     schemes outside production;
 *   • an https URL whose host is listed in PAYMENT_RETURN_URL_HOSTS. The list
 *     is empty by default: no web checkout exists today, so no web host is
 *     trusted until one is named. A host is never accepted for using https.
 */
export interface ReturnUrlPolicy {
  /** Custom URL schemes of the app, lowercase, without the colon. */
  schemes: string[];
  /** Exact https hosts (optionally `host:port`), lowercase. */
  hosts: string[];
}

/** The app's scheme, from MatorUI-/app.json. */
const APP_SCHEME = 'mator';
/** What `Linking.createURL` produces in Expo Go and in a development client. */
const DEV_SCHEMES = ['exp', 'exps', `exp+${APP_SCHEME}`];
const MAX_RETURN_URL_LENGTH = 512;

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

export function readReturnUrlPolicy(
  get: (key: string) => string | undefined,
): ReturnUrlPolicy {
  const configured = list(get('PAYMENT_RETURN_URL_SCHEMES'));
  const schemes = configured.length ? configured : [APP_SCHEME];
  return {
    schemes:
      get('NODE_ENV') === 'production'
        ? schemes
        : [...new Set([...schemes, ...DEV_SCHEMES])],
    hosts: list(get('PAYMENT_RETURN_URL_HOSTS')),
  };
}

/** Control characters, whitespace and the Payme separator, raw or encoded. */
function hasForbiddenCharacter(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000- \u007f;]/.test(value);
}

/** Why `value` is not an acceptable return URL, or null when it is one. */
export function returnUrlProblem(
  value: unknown,
  policy: ReturnUrlPolicy,
): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  if (value.length > MAX_RETURN_URL_LENGTH) return 'too long';
  if (hasForbiddenCharacter(value)) return 'forbidden character';
  // The same characters hidden behind percent-encoding, however many layers
  // deep: a provider or a browser decoding the value must not uncover a
  // separator or a line break.
  let decoded = value;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return 'malformed encoding';
    }
    if (next === decoded) break;
    decoded = next;
    if (hasForbiddenCharacter(decoded)) return 'forbidden character';
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (url.username || url.password) return 'credentials in URL';

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') {
    return policy.hosts.includes(url.host.toLowerCase())
      ? null
      : 'host not allowed';
  }
  return policy.schemes.includes(scheme) ? null : 'scheme not allowed';
}

/** @throws BadRequestException (INVALID_RETURN_URL) for anything not accepted. */
export function assertReturnUrl(
  value: string | undefined,
  policy: ReturnUrlPolicy,
): string | undefined {
  if (value === undefined) return undefined;
  const problem = returnUrlProblem(value, policy);
  if (problem) {
    throw new BadRequestException({
      code: 'INVALID_RETURN_URL',
      message: 'return_url is not an accepted payment return address.',
      details: { reason: problem },
    });
  }
  return value;
}
