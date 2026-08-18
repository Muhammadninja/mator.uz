import { EskizWebhookController } from './eskiz-webhook.controller';
import { SmsService } from './sms.service';

describe('EskizWebhookController', () => {
  let applyEskizCallback: jest.Mock;
  let controller: EskizWebhookController;

  beforeEach(() => {
    applyEskizCallback = jest
      .fn()
      .mockResolvedValue({ outcome: 'updated', status: 'delivered' });
    controller = new EskizWebhookController({
      applyEskizCallback,
    } as unknown as SmsService);
  });

  it('forwards message_id / status / error to the service', async () => {
    await controller.eskizCallback({
      message_id: 'msg-1',
      status: 'DELIVRD',
      error: undefined,
    });

    expect(applyEskizCallback).toHaveBeenCalledWith({
      messageId: 'msg-1',
      status: 'DELIVRD',
      error: undefined,
    });
  });

  it('falls back to `id` when Eskiz posts that spelling instead of message_id', async () => {
    await controller.eskizCallback({ id: 'msg-2', status: 'delivered' });

    expect(applyEskizCallback).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-2' }),
    );
  });

  it('prefers message_id over id when both are present', async () => {
    await controller.eskizCallback({ message_id: 'primary', id: 'secondary' });

    expect(applyEskizCallback).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'primary' }),
    );
  });

  it('answers { success: true } on a normal report', async () => {
    await expect(
      controller.eskizCallback({ message_id: 'msg-3', status: 'delivered' }),
    ).resolves.toEqual({ success: true });
  });

  it('still answers 200/{success:true} for an unusable payload (no redelivery storm)', async () => {
    applyEskizCallback.mockResolvedValueOnce({
      outcome: 'ignored',
      reason: 'missing_message_id',
    });

    await expect(controller.eskizCallback({})).resolves.toEqual({
      success: true,
    });
    expect(applyEskizCallback).toHaveBeenCalledWith({
      messageId: undefined,
      status: undefined,
      error: undefined,
    });
  });

  it('acknowledges even when the service reports a persistence error', async () => {
    applyEskizCallback.mockResolvedValueOnce({ outcome: 'error' });

    await expect(
      controller.eskizCallback({ message_id: 'msg-4', status: 'failed' }),
    ).resolves.toEqual({ success: true });
  });
});
