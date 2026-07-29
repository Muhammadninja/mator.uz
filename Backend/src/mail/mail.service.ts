import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { maskEmail } from '../common/pii.util';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly apiKey?: string;
  private readonly from: string;
  private readonly verifyBaseUrl: string;
  private readonly adminPanelUrl: string;
  private readonly adminInviteFrom: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('RESEND_API_KEY');
    this.from = this.config.get<string>('MAIL_FROM') ?? 'Mator <no-reply@mator.uz>';
    // Where the verification link points. Use the API for web/admin, or a
    // mobile deep-link (e.g. mator://verify-email) for app clients.
    this.verifyBaseUrl =
      this.config.get<string>('EMAIL_VERIFY_URL') ??
      'http://localhost:3000/v1/auth/verify-email';
    // Base URL of the operator admin panel — admin invite links point here. The
    // hidden segment is part of this value (e.g. https://mator.uz/mtr-ops-…).
    this.adminPanelUrl = (
      this.config.get<string>('ADMIN_PANEL_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    // The invite may use a dedicated sender; falls back to the shared MAIL_FROM.
    this.adminInviteFrom =
      this.config.get<string>('RESEND_FROM') ?? this.from;
  }

  /** The admin accept-invite link the invitee clicks. Raw token lives only here. */
  buildAdminInviteLink(rawToken: string): string {
    return `${this.adminPanelUrl}/accept-invite?token=${encodeURIComponent(rawToken)}`;
  }

  /**
   * Email a one-time admin invite link. Unlike the best-effort verification
   * mail, a missing RESEND_API_KEY here is a HARD failure (503): an invite that
   * is silently dropped would leave the inviter believing an admin was invited
   * when no email was ever sent. The raw token is never logged.
   */
  async sendAdminInvite(
    to: string,
    rawToken: string,
    inviterName: string,
  ): Promise<void> {
    if (!this.apiKey) {
      this.logger.error(
        `Cannot send admin invite to ${maskEmail(to)}: RESEND_API_KEY is not set.`,
      );
      throw new ServiceUnavailableException(
        'Email delivery is not configured. Set RESEND_API_KEY to send admin invites.',
      );
    }

    const link = this.buildAdminInviteLink(rawToken);
    const subject = 'Mator admin panelига taklif';
    const safeInviter = inviterName?.trim() || 'Mator jamoasi';
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
        <p>Assalomu alaykum,</p>
        <p><strong>${escapeHtml(safeInviter)}</strong> sizni Mator admin panelига administrator sifatida taklif qildi.</p>
        <p>Hisobingizni yakunlash uchun quyidagi tugmani bosing va parol o'rnating. Havola <strong>48 soatdan</strong> keyin amal qilmaydi.</p>
        <p style="margin: 24px 0;">
          <a href="${link}" style="background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Taklifni qabul qilish</a>
        </p>
        <p style="color:#666;font-size:13px;">Agar tugma ishlamasa, ushbu havolani brauzerga nusxalang:</p>
        <p style="color:#666;font-size:13px;word-break:break-all;">${link}</p>
        <p style="color:#666;font-size:13px;">Agar bu taklifni siz kutmagan bo'lsangiz, ushbu xatni e'tiborsiz qoldiring.</p>
      </div>
    `;
    const text =
      `${safeInviter} sizni Mator admin panelига administrator sifatida taklif qildi.\n\n` +
      `Hisobingizni yakunlash va parol o'rnatish uchun quyidagi havolaga o'ting (48 soat amal qiladi):\n${link}\n\n` +
      `Agar bu taklifni siz kutmagan bo'lsangiz, ushbu xatni e'tiborsiz qoldiring.`;

    await this.send(to, subject, html, text, this.adminInviteFrom);
  }

  buildVerificationLink(rawToken: string): string {
    const sep = this.verifyBaseUrl.includes('?') ? '&' : '?';
    return `${this.verifyBaseUrl}${sep}token=${rawToken}`;
  }

  async sendVerificationEmail(to: string, rawToken: string): Promise<void> {
    const link = this.buildVerificationLink(rawToken);
    const subject = 'Verify your Mator account';
    const html = `
      <p>Welcome to Mator!</p>
      <p>Please confirm your email address by clicking the link below. It expires in 24 hours.</p>
      <p><a href="${link}">Verify my email</a></p>
      <p>If you didn't create this account, you can safely ignore this email.</p>
    `;
    await this.send(to, subject, html);
  }

  private async send(
    to: string,
    subject: string,
    html: string,
    text?: string,
    from?: string,
  ): Promise<void> {
    // Dev / unconfigured fallback: never block registration on a missing key.
    if (!this.apiKey) {
      this.logger.warn(
        `[MAIL DISABLED] Would send "${subject}" to ${to}. Set RESEND_API_KEY to enable.`,
      );
      this.logger.debug(html.replace(/\s+/g, ' ').trim());
      return;
    }

    try {
      await axios.post(
        RESEND_ENDPOINT,
        { from: from ?? this.from, to, subject, html, ...(text ? { text } : {}) },
        { headers: { Authorization: `Bearer ${this.apiKey}` }, timeout: 10_000 },
      );
    } catch (err) {
      // Don't leak SMTP/provider errors to the client; log for ops and move on.
      this.logger.error(`Failed to send "${subject}" to ${maskEmail(to)}: ${(err as Error).message}`);
      throw err;
    }
  }
}

/** Escape untrusted text (e.g. inviter name) before interpolating into email HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
