import { Logger } from '@nestjs/common';
import axios from 'axios';
import { SmsProvider } from '../sms-provider.interface';

interface EskizConfig {
  baseUrl: string; // https://notify.eskiz.uz/api
  email: string;
  password: string;
  from?: string;
}

/**
 * Eskiz.uz aggregator. Auth is a bearer token obtained from email/password and
 * cached until it 401s, at which point it is transparently refreshed.
 */
export class EskizSmsProvider implements SmsProvider {
  readonly name = 'eskiz';
  private readonly logger = new Logger('EskizSmsProvider');
  private token?: string;

  constructor(private readonly cfg: EskizConfig) {}

  private async authenticate(): Promise<string> {
    const res = await axios.post(
      `${this.cfg.baseUrl}/auth/login`,
      { email: this.cfg.email, password: this.cfg.password },
      { timeout: 10_000 },
    );
    const token = res.data?.data?.token as string | undefined;
    if (!token) throw new Error('Eskiz auth returned no token');
    this.token = token;
    return token;
  }

  async send(toE164: string, text: string): Promise<void> {
    const mobilePhone = toE164.replace(/\D/g, ''); // Eskiz expects digits only
    const payload = {
      mobile_phone: mobilePhone,
      message: text,
      from: this.cfg.from ?? '4546',
    };

    const post = (token: string) =>
      axios.post(`${this.cfg.baseUrl}/message/sms/send`, payload, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });

    try {
      const token = this.token ?? (await this.authenticate());
      await post(token);
    } catch (err) {
      // Token likely expired — re-auth once, then retry.
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        const token = await this.authenticate();
        await post(token);
        return;
      }
      this.logger.error(`Eskiz send failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
