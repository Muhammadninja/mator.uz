import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Markup, Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { SourcingTicket } from '@prisma/client';

/**
 * Shape of the LLM extraction stored on a sourcing ticket's `extractedData`
 * jsonb. Every field is optional — the notifier reads defensively because the
 * column is untyped JSON.
 */
interface ExtractedFields {
  brand?: unknown;
  model?: unknown;
  year?: unknown;
  vin?: unknown;
  part_name?: unknown;
  preference?: unknown;
}

/**
 * Push-only Telegram notifier for AI sourcing tickets.
 *
 * When the AI chat can't find a requested part in stock it opens a sourcing
 * ticket; this fans that ticket out to the dealers' Telegram group so a human
 * can quote it fast (the 15-minute SLA the chat promises).
 *
 * ── Why a send-only Telegraf client (same call as TelegramAlertChannel) ──
 * The existing TelegramService is the SELLER bot: it long-polls via
 * `bot.launch()` and owns a large wizard dependency graph. This notifier only
 * ever issues `sendMessage` — a plain HTTPS Bot API call that holds no polling
 * connection — so it reuses the same bot TOKEN without touching that machinery.
 * Two Telegraf objects around one token is fine because only the seller bot
 * polls.
 *
 * Credentials come exclusively from the environment
 * (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_DEALERS_GROUP_ID`) — never hardcoded. When
 * either is unset the notifier is inert (logs a warning once, drops sends), so
 * a deployment without the group configured degrades gracefully rather than
 * crashing the chat.
 */
@Injectable()
export class TelegramNotifierService {
  private readonly logger = new Logger(TelegramNotifierService.name);
  private readonly botToken: string;
  private readonly dealersGroupId: string;
  /**
   * URL the «Связаться для доставки» card button opens (a manager's Telegram).
   * Empty → the card is sent without the button. Env-configured, never hardcoded.
   */
  private readonly managerContactUrl: string;
  /** Built lazily on first send — an unconfigured deployment builds nothing. */
  private client?: Telegraf;
  /** Cached bot @username (for the offer deep-link); resolved once via getMe. */
  private cachedUsername?: string;

  constructor(config: ConfigService) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ?? '';
    this.dealersGroupId =
      config.get<string>('TELEGRAM_DEALERS_GROUP_ID')?.trim() ?? '';
    this.managerContactUrl = this.normalizeContactUrl(
      config.get<string>('TELEGRAM_MANAGER_USERNAME'),
    );
    if (!this.configured) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN / TELEGRAM_DEALERS_GROUP_ID not set — sourcing tickets will NOT be sent to Telegram.',
      );
    }
  }

  /**
   * Turn the configured manager handle into a tappable URL. Accepts a full URL
   * (https://…, tg://…, wa.me/…), a `t.me/user` shorthand, or a bare `@username`
   * / `username`, which becomes `https://t.me/username`. Empty/undefined → ''.
   */
  private normalizeContactUrl(raw: string | undefined): string {
    const v = raw?.trim();
    if (!v) return '';
    if (/^(https?|tg):\/\//i.test(v)) return v;
    if (/^(t\.me|wa\.me)\//i.test(v)) return `https://${v}`;
    return `https://t.me/${v.replace(/^@/, '')}`;
  }

  /** Both the bot token and the destination group must be configured. */
  get configured(): boolean {
    return this.botToken !== '' && this.dealersGroupId !== '';
  }

  /**
   * Post one sourcing ticket to the dealers group as an HTML card.
   *
   * Resolves (never rejects) so a Telegram outage can't fail the AI-chat
   * request that triggered it — the caller dispatches this without awaiting.
   * Delivery problems are logged, not thrown.
   */
  async sendSourcingTicketToDealers(ticket: SourcingTicket): Promise<void> {
    if (!this.configured) return;

    try {
      const text = this.formatTicket(ticket);
      await this.bot().telegram.sendMessage(this.dealersGroupId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(await this.cardMarkup(ticket.id)),
      });
      this.logger.debug(`Sourcing ticket ${ticket.id} sent to dealers group`);
    } catch (err) {
      this.logger.error(
        `Failed to send sourcing ticket ${ticket.id} to Telegram: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Build the HTML message body. Exposed for unit testing the formatting. */
  formatTicket(ticket: SourcingTicket): string {
    const data = (ticket.extractedData ?? {}) as ExtractedFields;

    const rows: string[] = [
      '🔧 <b>New sourcing request</b>',
      '',
      this.row('Brand', data.brand),
      this.row('Model', data.model),
      this.row('Year', data.year),
      this.row('VIN', data.vin),
      this.row('Part', data.part_name),
      this.row('Preference', data.preference),
    ].filter((r): r is string => r !== null);

    const raw = this.str(ticket.rawMessage);
    if (raw) {
      rows.push('', `<b>Message:</b> ${this.escape(raw)}`);
    }

    rows.push('', `<i>Ticket ${this.escape(ticket.id)}</i>`);
    return rows.join('\n');
  }

  /** A "<b>Label:</b> value" line, or null when the value is empty. */
  private row(label: string, value: unknown): string | null {
    const v = this.str(value);
    return v ? `<b>${label}:</b> ${this.escape(v)}` : null;
  }

  private str(value: unknown): string | null {
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return null;
  }

  /** Escape the five characters Telegram HTML mode treats specially. */
  private escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * The card's inline keyboard, as a partial sendMessage option ({ reply_markup }):
   *   • «🙋 У меня есть» — deep-links the dealer into a private bot chat that runs
   *     the offer-capture flow (`/start offer_<ticketId>`). Present only when the
   *     bot @username resolves.
   *   • «Связаться для доставки» — the manager DM (when configured).
   * Returns {} when neither button can be built, so the card is sent bare.
   */
  async cardMarkup(ticketId: string): Promise<{ reply_markup?: InlineKeyboardMarkup }> {
    const rows: ReturnType<typeof Markup.button.url>[][] = [];

    const username = await this.botUsername();
    if (username) {
      // `offer_` prefix must match OFFER_DEEPLINK_PREFIX in telegram-offer.service.
      rows.push([
        Markup.button.url(
          '🙋 У меня есть',
          `https://t.me/${username}?start=offer_${ticketId}`,
        ),
      ]);
    }
    if (this.managerContactUrl) {
      rows.push([Markup.button.url('Связаться для доставки', this.managerContactUrl)]);
    }

    return rows.length ? Markup.inlineKeyboard(rows) : {};
  }

  /** Bot @username, resolved once via getMe and cached. Null on failure (retried
   *  next send — a transient getMe error must not permanently drop the button). */
  private async botUsername(): Promise<string | null> {
    if (this.cachedUsername) return this.cachedUsername;
    try {
      const me = await this.bot().telegram.getMe();
      this.cachedUsername = me.username ?? undefined;
      return this.cachedUsername ?? null;
    } catch (err) {
      this.logger.warn(
        `getMe failed — offer deep-link button omitted this send: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** The send-only client, constructed once on first use. */
  private bot(): Telegraf {
    this.client ??= new Telegraf(this.botToken);
    return this.client;
  }
}
