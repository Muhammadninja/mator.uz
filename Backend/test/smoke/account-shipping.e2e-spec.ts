import { AccountService } from '../../src/account/account.service';
import { ShippingService } from '../../src/shipping/shipping.service';
import { createPrismaMock, fakeConfig, PrismaMock } from '../utils/harness';

describe('Account + Shipping smoke', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  describe('Account', () => {
    it('lists the user addresses in contract shape', async () => {
      const svc = new AccountService(prisma, fakeConfig());
      prisma.address.findMany.mockResolvedValue([
        {
          id: 'addr_1',
          label: 'Home',
          regionCode: '01',
          district: 'Yunusobod',
          street: 'Amir Temur',
          fullText: 'Tashkent, Amir Temur 1',
          lat: 41.3,
          lng: 69.2,
          isDefault: true,
          createdAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]);

      const res: any = await svc.listAddresses('usr_1');

      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({ id: 'addr_1', full_text: 'Tashkent, Amir Temur 1', is_default: true });
      expect(prisma.address.findMany.mock.calls[0][0].where).toEqual({ userId: 'usr_1' });
    });

    it('returns the configured payment providers (default payme alone — click only once listed and configured)', () => {
      // Click is offered only when it is actually enabled: listed AND its
      // CLICK_SECRET_KEY set. Unconfigured, its webhook fails closed, so
      // listing it would offer a method that cannot be paid. Payme is the only
      // provider for now, so by default Click is not listed, secret or not.
      const secretOnly = new AccountService(
        prisma,
        fakeConfig({ CLICK_SECRET_KEY: 'click-secret' }),
      );
      expect((secretOnly.paymentMethods() as any).items).toEqual([
        { provider: 'payme', saved: false },
      ]);

      const configured = new AccountService(
        prisma,
        fakeConfig({
          PAYMENT_PROVIDERS: 'payme,click',
          CLICK_SECRET_KEY: 'click-secret',
        }),
      );
      expect((configured.paymentMethods() as any).items).toEqual([
        { provider: 'payme', saved: false },
        { provider: 'click', saved: false },
      ]);
    });

    it('honors PAYMENT_PROVIDERS override', () => {
      const svc = new AccountService(prisma, fakeConfig({ PAYMENT_PROVIDERS: 'payme' }));
      expect((svc.paymentMethods() as any).items).toEqual([{ provider: 'payme', saved: false }]);
    });
  });

  describe('Shipping', () => {
    const shipping = () =>
      new ShippingService(
        { quoteCart: jest.fn() } as any,
        { consume: jest.fn(async () => ({ allowed: true, retryAfter: 0 })) } as any,
        { get: () => undefined } as any,
      );

    it('offers pickup, free', async () => {
      const res: any = await shipping().quote('usr_1', {} as any);
      const pickup = res.options.find((o: any) => o.type === 'pickup');
      expect(pickup.price_uzs).toBe(0);
      expect(res.currency).toBe('UZS');
    });

    it('quotes no courier price to a client that does not ask for one', async () => {
      const res: any = await shipping().quote('usr_1', {} as any);
      expect(res.options.map((o: any) => o.type)).toEqual(['pickup']);
    });
  });
});
