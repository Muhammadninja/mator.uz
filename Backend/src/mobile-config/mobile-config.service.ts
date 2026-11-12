import { Injectable, Logger } from '@nestjs/common';

// Android resolves by package; iOS needs the numeric App Store id, so the iOS
// link should be set explicitly via env once the app is published.
const DEFAULT_ANDROID_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.mator.myapp';

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
  /**
   * Where a buyer reaches a person: returns, refunds and order problems. Each
   * channel is null when unset or malformed, and the app hides it — it never
   * shows a contact nobody configured.
   */
  support: SupportContacts;
}

export interface SupportContacts {
  /** E.164, e.g. "+998502030318" — for a `tel:` link. */
  phone: string | null;
  email: string | null;
  /** Without "@", e.g. "Mator_AutoParts" — for a t.me link. */
  telegram_username: string | null;
}

const PHONE_PATTERN = /^\+?[0-9]{9,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Telegram's own rule: 5–32 characters, letters, digits and underscores,
// starting with a letter.
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

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
 *   APP_SUPPORT_PHONE           support phone, e.g. "+998 (50) 203-03-18"
 *   APP_SUPPORT_EMAIL           support e-mail
 *   APP_SUPPORT_TELEGRAM        support Telegram username, e.g. "@Mator_AutoParts"
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
  private readonly logger = new Logger(MobileConfigService.name);

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
      support: this.supportContacts(),
    };
  }

  /**
   * Support channels from env, normalised and validated: this is a system
   * boundary, and a typo must hide the channel rather than send buyers to a
   * wrong number. A malformed value is logged so the operator can see why.
   */
  private supportContacts(): SupportContacts {
    const phoneRaw = process.env.APP_SUPPORT_PHONE?.trim() || '';
    const phoneDigits = phoneRaw.replace(/[\s()-]/g, '');
    const phone = phoneDigits
      ? this.validOrNull('APP_SUPPORT_PHONE', phoneDigits, PHONE_PATTERN)
      : null;

    const emailRaw = process.env.APP_SUPPORT_EMAIL?.trim() || '';
    const email = emailRaw
      ? this.validOrNull('APP_SUPPORT_EMAIL', emailRaw, EMAIL_PATTERN)
      : null;

    const telegramRaw = (process.env.APP_SUPPORT_TELEGRAM?.trim() || '')
      .replace(/^https?:\/\/t\.me\//i, '')
      .replace(/^@/, '');
    const telegram = telegramRaw
      ? this.validOrNull('APP_SUPPORT_TELEGRAM', telegramRaw, TELEGRAM_USERNAME_PATTERN)
      : null;

    return {
      phone: phone === null ? null : phone.startsWith('+') ? phone : `+${phone}`,
      email,
      telegram_username: telegram,
    };
  }

  private validOrNull(name: string, value: string, pattern: RegExp): string | null {
    if (pattern.test(value)) return value;
    this.logger.warn(`${name} is malformed and is not served to the app.`);
    return null;
  }
}
