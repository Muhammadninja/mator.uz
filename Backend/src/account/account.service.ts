import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

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
    const enabled = (this.config.get<string>('PAYMENT_PROVIDERS') ?? 'payme,click')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    return { items: enabled.map((provider) => ({ provider, saved: false })) };
  }
}
