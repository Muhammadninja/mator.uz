import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Markup, Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { SourcingTicket } from '@prisma/client';
import { maskVin } from '../sourcing/sourcing-keys';

/** How a send went. Sourcing retries on failure, so it has to know. */
export type TelegramSendResult = { ok: true } | { ok: false; error: string };

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
  /** Present on a ticket opened because a checkout could not be supplied. */
  stock_shortage?: {
    part_id?: unknown;
    part_numbers?: unknown;
    requested_qty?: unknown;
    seller?: unknown;
    reported_qty?: unknown;
    reserved_qty?: unknown;
    reference?: unknown;
  };
}

/**
 * Push-only Telegram notifier for AI sourcing tickets.
 *
 * When the AI chat can't find a requested part in stock it opens a sourcing
 * ticket; this fans that ticket out to the dealers' Telegram group so a human
 * can quote it.
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
  private readonly escalationChatId: string;
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
    this.escalationChatId =
      config.get<string>('TELEGRAM_SOURCING_ESCALATION_CHAT_ID')?.trim() ?? '';
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
   * Post one sourcing ticket to the dealers group as an HTML card. Never rejects,
   * and reports the outcome so the caller can retry. An unconfigured deployment
   * counts as a failure: the ticket has not reached anyone.
   */
  async sendSourcingTicketToDealers(ticket: SourcingTicket): Promise<TelegramSendResult> {
    if (!this.configured) return { ok: false, error: 'Dealers group not configured' };
    try {
      await this.bot().telegram.sendMessage(this.dealersGroupId, this.formatTicket(ticket), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(await this.cardMarkup(ticket.id)),
      });
      this.logger.debug(`Sourcing ticket ${ticket.id} sent to dealers group`);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send sourcing ticket ${ticket.id} to Telegram: ${error}`);
      return { ok: false, error };
    }
  }

  get escalationConfigured(): boolean {
    return this.botToken !== '' && this.escalationChatId !== '';
  }

  /** Tell internal staff a ticket needs attention. No customer details. */
  async sendSourcingEscalation(ticket: SourcingTicket): Promise<TelegramSendResult> {
    if (!this.escalationConfigured) return { ok: false, error: 'Escalation chat not configured' };
    const part = this.str(ticket.partName) ?? '—';
    const delivery = ticket.staffNotifyStatus === 'FAILED' ? 'не доставлена дилерам' : 'не взята в работу';
    try {
      await this.bot().telegram.sendMessage(
        this.escalationChatId,
        `⚠️ <b>Заявка требует внимания</b> (${delivery})\n\n` +
          `<b>Part:</b> ${this.escape(part)}\n<i>Ticket ${this.escape(ticket.id)}</i>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      );
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to escalate sourcing ticket ${ticket.id}: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * The HTML card dealers see: the part and what's needed to quote it. The group
   * is outside the company, so no customer contact, no raw message (it can hold
   * anything the customer typed), and no full VIN.
   */
  formatTicket(ticket: SourcingTicket): string {
    const data = (ticket.extractedData ?? {}) as ExtractedFields;
    const vin = this.str(data.vin);

    const rows: string[] = [
      '🔧 <b>New sourcing request</b>',
      '',
      this.row('Part', ticket.partName ?? data.part_name),
      this.row('Brand', data.brand),
      this.row('Model', data.model),
      this.row('Year', data.year),
      this.row('VIN', vin ? maskVin(vin) : null),
      this.row('Preference', data.preference),
      ...this.shortageRows(data),
    ].filter((r): r is string => r !== null);

    rows.push('', `<i>Ticket ${this.escape(ticket.id)}</i>`);
    return rows.join('\n');
  }

  /** What a stock shortage adds to the card. Nothing about the customer. */
  private shortageRows(data: ExtractedFields): (string | null)[] {
    const s = data.stock_shortage;
    if (!s) return [];
    const numbers = Array.isArray(s.part_numbers)
      ? s.part_numbers.join(', ')
      : null;
    return [
      this.row('Part ID', s.part_id),
      this.row('OEM/GM', numbers),
      this.row('Quantity needed', s.requested_qty),
      this.row('Could not supply', s.seller),
      this.row('Supplier-reported', s.reported_qty),
      this.row('Reserved', s.reserved_qty),
      this.row('Reference', s.reference),
    ];
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

  /**
   * DM the dealer that the customer ACCEPTED their offer (bought it). The dealer
   * DM'd the bot to submit the offer, so their `sellerTgId` chat is reachable.
   * Send-only, resolves-never-rejects — a Telegram hiccup never fails the accept.
   */
  async notifyDealerOfferAccepted(
    sellerTgId: string,
    partName: string | null,
    priceText: string,
  ): Promise<void> {
    const part = this.escape(partName ?? 'запчасть');
    await this.dmDealer(
      sellerTgId,
      `✅ <b>Ваше предложение принято!</b>\n\n${part} — ${this.escape(priceText)}\n\n` +
        'Покупатель добавил товар в корзину. Свяжитесь с менеджером для организации доставки.',
    );
  }

  /** DM the dealer that the customer DECLINED their offer, with the reason. */
  async notifyDealerOfferDeclined(
    sellerTgId: string,
    partName: string | null,
    reasonLabel?: string | null,
  ): Promise<void> {
    const part = this.escape(partName ?? 'запчасть');
    const reason = reasonLabel ? `\nПричина: ${this.escape(reasonLabel)}` : '';
    await this.dmDealer(
      sellerTgId,
      `❌ Покупатель отклонил ваше предложение (${part}).${reason}`,
    );
  }

  /** Send one HTML DM to a dealer by their Telegram user id. Only the bot token
   *  is required (not the group). Logs, never throws. */
  private async dmDealer(sellerTgId: string, html: string): Promise<void> {
    if (!this.botToken || !sellerTgId) return;
    try {
      await this.bot().telegram.sendMessage(sellerTgId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to DM dealer ${sellerTgId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The send-only client, constructed once on first use. */
  private bot(): Telegraf {
    this.client ??= new Telegraf(this.botToken);
    return this.client;
  }
}
