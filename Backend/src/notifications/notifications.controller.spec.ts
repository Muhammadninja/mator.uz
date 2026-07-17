// Unit tests for the dev-only POST /v1/notifications/test endpoint. The
// contract under test: the endpoint is gated on AUTH_DEV_MODE and, when
// enabled, delegates to the single authoritative NotificationsService.emit()
// path (no parallel creation logic). NotificationsService and ConfigService are
// mocked.

import { NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { NotificationsController } from './notifications.controller';

function build(devMode: boolean) {
  const emit = jest.fn().mockResolvedValue({ id: 'ntf_test' });
  const notifications = { emit } as never;
  const config = {
    get: jest.fn((key: string) =>
      key === 'AUTH_DEV_MODE' ? (devMode ? 'true' : 'false') : undefined,
    ),
  } as never;
  const controller = new NotificationsController(notifications, config);
  return { controller, emit };
}

const req = { user: { id: 'usr_1' } };

describe('NotificationsController — POST /test (dev-only)', () => {
  it('emits through the real pipeline when AUTH_DEV_MODE=true', async () => {
    const { controller, emit } = build(true);

    const res = await controller.createTest(req, {
      title: 'Hello',
      body: 'World',
      type: NotificationType.AI_REPLY,
      deeplink_path: '/(tabs)/(advisor)',
      data: { foo: 'bar' },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('usr_1', {
      type: NotificationType.AI_REPLY,
      title: 'Hello',
      body: 'World',
      data: { foo: 'bar' },
      deeplinkPath: '/(tabs)/(advisor)',
    });
    expect(res).toEqual({ id: 'ntf_test' });
  });

  it('defaults type to ORDER_PAID and deeplinkPath to null when omitted', async () => {
    const { controller, emit } = build(true);

    await controller.createTest(req, { title: 'T', body: 'B' } as never);

    expect(emit).toHaveBeenCalledWith('usr_1', {
      type: NotificationType.ORDER_PAID,
      title: 'T',
      body: 'B',
      data: undefined,
      deeplinkPath: null,
    });
  });

  it('404s and creates nothing when AUTH_DEV_MODE is off', async () => {
    const { controller, emit } = build(false);

    await expect(
      controller.createTest(req, { title: 'T', body: 'B' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(emit).not.toHaveBeenCalled();
  });
});
