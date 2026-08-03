import { ConfigService } from '@nestjs/config';
import type { SourcingTicket } from '@prisma/client';
import { TelegramNotifierService } from './telegram-notifier.service';

/** A ConfigService stub returning the given env map. */
function configWith(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function ticket(overrides: Partial<SourcingTicket> = {}): SourcingTicket {
  return {
    id: 'tkt_1',
    userId: null,
    rawMessage: 'Нужны передние колодки',
    extractedData: {
      brand: 'Chevrolet',
      model: 'Cobalt',
      year: '2020',
      vin: null,
      part_name: 'передние колодки',
      preference: 'cheapest',
    },
    status: 'PENDING',
    createdAt: new Date('2026-08-04T00:00:00Z'),
    ...overrides,
  } as unknown as SourcingTicket;
}

/** Give the service a fake send-only client so no network is touched. */
function withFakeClient(service: TelegramNotifierService) {
  const sendMessage = jest.fn().mockResolvedValue(undefined);
  (service as unknown as { client: unknown }).client = {
    telegram: { sendMessage },
  };
  return sendMessage;
}

const FULL_ENV = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_DEALERS_GROUP_ID: '-1009999',
  TELEGRAM_MANAGER_USERNAME: '@mator_manager',
};

describe('TelegramNotifierService', () => {
  describe('configuration', () => {
    it('is configured only when both token and group id are present', () => {
      expect(new TelegramNotifierService(configWith(FULL_ENV)).configured).toBe(
        true,
      );
      expect(
        new TelegramNotifierService(
          configWith({ TELEGRAM_BOT_TOKEN: 'x' }),
        ).configured,
      ).toBe(false);
      expect(
        new TelegramNotifierService(configWith({})).configured,
      ).toBe(false);
    });

    it('does nothing (and never throws) when unconfigured', async () => {
      const service = new TelegramNotifierService(configWith({}));
      const sendMessage = withFakeClient(service);
      await expect(
        service.sendSourcingTicketToDealers(ticket()),
      ).resolves.toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('formatTicket', () => {
    const service = new TelegramNotifierService(configWith(FULL_ENV));

    it('includes every populated field and the raw message + ticket id', () => {
      const text = service.formatTicket(ticket());
      expect(text).toContain('<b>Brand:</b> Chevrolet');
      expect(text).toContain('<b>Model:</b> Cobalt');
      expect(text).toContain('<b>Year:</b> 2020');
      expect(text).toContain('<b>Part:</b> передние колодки');
      expect(text).toContain('<b>Preference:</b> cheapest');
      expect(text).toContain('Нужны передние колодки');
      expect(text).toContain('tkt_1');
    });

    it('omits empty fields (null VIN)', () => {
      expect(service.formatTicket(ticket())).not.toContain('VIN');
    });

    it('escapes HTML-special characters to keep the markup valid', () => {
      const text = service.formatTicket(
        ticket({ rawMessage: 'fits <A&B> models' }),
      );
      expect(text).toContain('fits &lt;A&amp;B&gt; models');
      expect(text).not.toContain('<A&B>');
    });

    it('tolerates a missing/empty extractedData blob', () => {
      const text = service.formatTicket(
        ticket({ extractedData: null as never, rawMessage: 'hi' }),
      );
      expect(text).toContain('New sourcing request');
      expect(text).toContain('hi');
    });
  });

  describe('sendSourcingTicketToDealers', () => {
    it('posts HTML to the configured group', async () => {
      const service = new TelegramNotifierService(configWith(FULL_ENV));
      const sendMessage = withFakeClient(service);
      await service.sendSourcingTicketToDealers(ticket());
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text, opts] = sendMessage.mock.calls[0];
      expect(chatId).toBe('-1009999');
      expect(text).toContain('<b>Part:</b> передние колодки');
      expect(opts).toMatchObject({ parse_mode: 'HTML' });
    });

    it('attaches the «Связаться для доставки» URL button (@username → t.me url)', async () => {
      const service = new TelegramNotifierService(configWith(FULL_ENV));
      const sendMessage = withFakeClient(service);
      await service.sendSourcingTicketToDealers(ticket());
      const opts = sendMessage.mock.calls[0][2];
      const button = opts.reply_markup.inline_keyboard[0][0];
      expect(button).toMatchObject({
        text: 'Связаться для доставки',
        url: 'https://t.me/mator_manager',
      });
    });

    it('omits the button when no manager contact is configured', async () => {
      const service = new TelegramNotifierService(
        configWith({
          TELEGRAM_BOT_TOKEN: 'bot-token',
          TELEGRAM_DEALERS_GROUP_ID: '-1009999',
        }),
      );
      const sendMessage = withFakeClient(service);
      await service.sendSourcingTicketToDealers(ticket());
      expect(sendMessage.mock.calls[0][2].reply_markup).toBeUndefined();
    });

    it('accepts a full URL for the manager contact unchanged', () => {
      const service = new TelegramNotifierService(
        configWith({ ...FULL_ENV, TELEGRAM_MANAGER_USERNAME: 'https://wa.me/998901112233' }),
      );
      const markup = service.deliveryButtonMarkup();
      expect(markup.reply_markup?.inline_keyboard[0][0]).toMatchObject({
        url: 'https://wa.me/998901112233',
      });
    });

    it('resolves (never rejects) when Telegram delivery fails', async () => {
      const service = new TelegramNotifierService(configWith(FULL_ENV));
      (service as unknown as { client: unknown }).client = {
        telegram: {
          sendMessage: jest.fn().mockRejectedValue(new Error('429 flood')),
        },
      };
      await expect(
        service.sendSourcingTicketToDealers(ticket()),
      ).resolves.toBeUndefined();
    });
  });
});
