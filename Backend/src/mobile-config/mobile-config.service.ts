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
 *
 * The minimum defaults to "0.0.0" so NOTHING is ever forced until an operator
 * sets a real value — safe to ship immediately.
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
    };
  }
}
