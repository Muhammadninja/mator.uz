import { NotificationType } from '@prisma/client';
import { ExpoPushProvider } from '../../src/notifications/push/providers/expo.provider';
import { PushDispatchService } from '../../src/notifications/push/push-dispatch.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { SettlementService } from '../../src/orders/webhooks/settlement.service';
import { createPrismaMock, fakeConfig, PrismaMock } from '../utils/harness';

describe('Push delivery smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  describe('ExpoPushProvider', () => {
    const realFetch = global.fetch;
    afterEach(() => (global.fetch = realFetch));

    it('maps Expo tickets to per-token results (ok + DeviceNotRegistered)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        json: async () => ({ data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
      }) as any;
      const expo = new ExpoPushProvider(fakeConfig());
      const res = await expo.send([
        { token: 't1', title: 'a', body: 'b' },
        { token: 't2', title: 'a', body: 'b' },
      ]);
      expect(res[0]).toEqual({ token: 't1', ok: true });
      expect(res[1]).toEqual({ token: 't2', ok: false, error: 'DeviceNotRegistered' });
    });

    it('short-circuits with no network call when there are no messages', async () => {
      global.fetch = jest.fn() as any;
      const expo = new ExpoPushProvider(fakeConfig());
      expect(await expo.send([])).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('PushDispatchService', () => {
    it('routes each device by token type and prunes dead tokens', async () => {
      const expo = { send: jest.fn().mockResolvedValue([{ token: 'expo1', ok: false, error: 'DeviceNotRegistered' }]) };
      const fcm = { send: jest.fn().mockResolvedValue([]) };
      const apns = { send: jest.fn().mockResolvedValue([]) };
      const dispatch = new PushDispatchService(prisma, expo as any, fcm as any, apns as any);
      prisma.device.findMany.mockResolvedValue([
        { expoPushToken: 'expo1', fcmToken: null, apnsToken: null },
        { expoPushToken: null, fcmToken: 'fcm1', apnsToken: null },
      ]);
      prisma.device.updateMany.mockResolvedValue({ count: 1 });

      await dispatch.sendToUser('usr_1', { title: 't', body: 'b' });

      expect(expo.send).toHaveBeenCalledWith([expect.objectContaining({ token: 'expo1' })]);
      expect(fcm.send).toHaveBeenCalledWith([expect.objectContaining({ token: 'fcm1' })]);
      expect(prisma.device.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { expoPushToken: { in: ['expo1'] } }, data: { expoPushToken: null } }),
      );
    });

    it('no-ops for a user with no devices', async () => {
      const expo = { send: jest.fn() };
      const dispatch = new PushDispatchService(prisma, expo as any, { send: jest.fn() } as any, { send: jest.fn() } as any);
      prisma.device.findMany.mockResolvedValue([]);
      await dispatch.sendToUser('usr_1', { title: 't', body: 'b' });
      expect(expo.send).not.toHaveBeenCalled();
    });
  });

  describe('NotificationsService.emit', () => {
    function build() {
      const push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
      const svc = new NotificationsService(prisma, push as any);
      prisma.notification.create.mockResolvedValue({ id: 'ntf_1' });
      return { svc, push };
    }

    it('persists the inbox row and pushes when allowed', async () => {
      const { svc, push } = build();
      prisma.notificationPreference.findUnique.mockResolvedValue(null); // default allow
      await svc.emit('usr_1', { type: NotificationType.ORDER_PAID, title: 't', body: 'b' });
      expect(prisma.notification.create).toHaveBeenCalled();
      expect(push.sendToUser).toHaveBeenCalled();
    });

    it('stores the inbox row but skips push when the category preference is off', async () => {
      const { svc, push } = build();
      prisma.notificationPreference.findUnique.mockResolvedValue({ payments: false, quietHoursStart: null, quietHoursEnd: null });
      await svc.emit('usr_1', { type: NotificationType.ORDER_PAID, title: 't', body: 'b' });
      expect(prisma.notification.create).toHaveBeenCalled();
      expect(push.sendToUser).not.toHaveBeenCalled();
    });

    it('suppresses push during quiet hours', async () => {
      const { svc, push } = build();
      prisma.notificationPreference.findUnique.mockResolvedValue({ payments: true, quietHoursStart: '00:00', quietHoursEnd: '23:59' });
      await svc.emit('usr_1', { type: NotificationType.ORDER_PAID, title: 't', body: 'b' });
      expect(push.sendToUser).not.toHaveBeenCalled();
    });

    it('never throws when push delivery fails', async () => {
      const { svc, push } = build();
      prisma.notificationPreference.findUnique.mockResolvedValue(null);
      push.sendToUser.mockRejectedValue(new Error('expo down'));
      await expect(svc.emit('usr_1', { type: NotificationType.AI_REPLY, title: 't', body: 'b' })).resolves.toBeDefined();
    });
  });

  describe('order_paid wiring', () => {
    it('SettlementService.markPaid emits an ORDER_PAID notification after commit', async () => {
      const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
      const settlement = new SettlementService(prisma, notifications as any);
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        status: 'PENDING',
        orderId: 'ord_1',
        amountUzs: 215000,
        order: { userId: 'usr_1' },
      });

      await settlement.markPaid('pay_1', 1700000000000);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(notifications.emit).toHaveBeenCalledWith(
        'usr_1',
        expect.objectContaining({ type: NotificationType.ORDER_PAID, data: { order_id: 'ord_1', payment_id: 'pay_1' } }),
      );
    });

    it('is idempotent — an already-paid payment does not re-notify', async () => {
      const notifications = { emit: jest.fn() };
      const settlement = new SettlementService(prisma, notifications as any);
      prisma.payment.findUnique.mockResolvedValue({ id: 'pay_1', status: 'PAID', orderId: 'ord_1', order: { userId: 'usr_1' } });
      await settlement.markPaid('pay_1');
      expect(notifications.emit).not.toHaveBeenCalled();
    });
  });
});
