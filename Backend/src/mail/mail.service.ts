import { Injectable, Logger } from '@nestjs/common';
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

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('RESEND_API_KEY');
    this.from = this.config.get<string>('MAIL_FROM') ?? 'Mator <no-reply@mator.uz>';
    // Where the verification link points. Use the API for web/admin, or a
    // mobile deep-link (e.g. mator://verify-email) for app clients.
    this.verifyBaseUrl =
      this.config.get<string>('EMAIL_VERIFY_URL') ??
      'http://localhost:3000/v1/auth/verify-email';
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

  private async send(to: string, subject: string, html: string): Promise<void> {
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
        { from: this.from, to, subject, html },
        { headers: { Authorization: `Bearer ${this.apiKey}` }, timeout: 10_000 },
      );
    } catch (err) {
      // Don't leak SMTP/provider errors to the client; log for ops and move on.
      this.logger.error(`Failed to send "${subject}" to ${maskEmail(to)}: ${(err as Error).message}`);
      throw err;
    }
  }
}
