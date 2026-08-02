import { Injectable } from '@nestjs/common';

// Android resolves by package; iOS needs the numeric App Store id, so the iOS
// link should be set explicitly via env once the app is published.
const DEFAULT_ANDROID_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.fotih12.mator';

export interface MobileAppConfig {
  min_supported_version: string;
  latest_version: string;
  ios_store_url: string | null;
  android_store_url: string;
  /**
   * Stable public URL of the Privacy Policy. App Store Connect requires one, and
   * the app links to it from its settings/legal screen.
   *
   * NULL until the product/legal owner supplies the real document — the backend
   * deliberately does NOT store, host or invent the legal text. Serving a
   * fabricated policy would be worse than serving none, because it would look
   * approved. A null here is the client's signal to hide the link, and it is a
   * RELEASE BLOCKER: see docs/RELEASE_CHECKLIST.md.
   */
  privacy_policy_url: string | null;
  /** Stable public URL of the Terms & Conditions. Same contract as above. */
  terms_url: string | null;
}

/**
 * Config surfaced to the mobile client at GET /v1/app/config — today just the
 * force-update gate (minimum supported app version + store links). Driven by env
 * so an operator can force an update with a RESTART, no code deploy:
 *
 *   APP_MIN_SUPPORTED_VERSION   e.g. "1.1.0" — builds below this must update
 *   APP_LATEST_VERSION          e.g. "1.1.0" — informational
 *   APP_IOS_STORE_URL           full App Store URL (needs the numeric id)
 *   APP_ANDROID_STORE_URL       Play Store URL (defaults to the app's package)
 *   APP_PRIVACY_POLICY_URL      stable public Privacy Policy URL  (release blocker)
 *   APP_TERMS_URL               stable public Terms & Conditions URL (release blocker)
 *
 * The minimum defaults to "0.0.0" so NOTHING is ever forced until an operator
 * sets a real value — safe to ship immediately.
 *
 * The two legal URLs default to NULL rather than to a placeholder: the backend
 * neither stores nor authors the legal text, and shipping invented "final" legal
 * content would be actively harmful. The product/legal owner supplies the real
 * documents and the URLs are set here, with no code deploy — see
 * docs/RELEASE_CHECKLIST.md for what remains before App Store submission.
 */
@Injectable()
export class MobileConfigService {
  getConfig(): MobileAppConfig {
    const min = process.env.APP_MIN_SUPPORTED_VERSION?.trim() || '0.0.0';
    const latest = process.env.APP_LATEST_VERSION?.trim() || min;
    return {
      min_supported_version: min,
      latest_version: latest,
      ios_store_url: process.env.APP_IOS_STORE_URL?.trim() || null,
      android_store_url:
        process.env.APP_ANDROID_STORE_URL?.trim() || DEFAULT_ANDROID_STORE_URL,
      // No fallback URL on purpose — an unset value must read as "not supplied
      // yet", never as a placeholder document the app could show as final.
      privacy_policy_url: process.env.APP_PRIVACY_POLICY_URL?.trim() || null,
      terms_url: process.env.APP_TERMS_URL?.trim() || null,
    };
  }
}
