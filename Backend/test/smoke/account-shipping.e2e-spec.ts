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

    it('returns the configured payment providers (default payme,click — click only once configured)', () => {
      // Click is offered only when it is actually enabled: listed AND its
      // CLICK_SECRET_KEY set. Unconfigured, its webhook fails closed, so
      // listing it would offer a method that cannot be paid.
      const unconfigured = new AccountService(prisma, fakeConfig());
      expect((unconfigured.paymentMethods() as any).items).toEqual([
        { provider: 'payme', saved: false },
      ]);

      const configured = new AccountService(
        prisma,
        fakeConfig({ CLICK_SECRET_KEY: 'click-secret' }),
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
    it('offers pickup, free', () => {
      const res: any = new ShippingService().quote({} as any);
      const pickup = res.options.find((o: any) => o.type === 'pickup');
      expect(pickup.price_uzs).toBe(0);
      expect(res.currency).toBe('UZS');
    });

    it('quotes no courier price: there is no real tariff to quote yet', () => {
      const res: any = new ShippingService().quote({} as any);
      expect(res.options.map((o: any) => o.type)).toEqual(['pickup']);
    });
  });
});
