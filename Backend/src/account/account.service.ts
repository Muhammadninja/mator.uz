import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  enabledPaymentProviders,
  isClickEnabled,
} from '../orders/webhooks/click.config';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Saved delivery addresses for the user (default first, then newest). */
  async listAddresses(userId: string) {
    const addresses = await this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      items: addresses.map((a) => ({
        id: a.id,
        label: a.label,
        region_code: a.regionCode,
        district: a.district,
        street: a.street,
        full_text: a.fullText,
        lat: a.lat,
        lng: a.lng,
        is_default: a.isDefault,
        created_at: a.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Available payment providers. There is no per-user saved-card storage yet
   * (Payme/Click are redirect/deeplink flows), so this lists the providers the
   * checkout supports rather than stored instruments.
   */
  paymentMethods() {
    const get = (k: string) => this.config.get<string>(k);
    // Click is listed only when it is actually enabled (listed AND its secret
    // configured — see click.config.ts); otherwise the app would offer a
    // method whose invoices and webhook are refused.
    const enabled = enabledPaymentProviders(get).filter(
      (provider) => provider !== 'click' || isClickEnabled(get),
    );
    return { items: enabled.map((provider) => ({ provider, saved: false })) };
  }
}
