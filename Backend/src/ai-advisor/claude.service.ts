import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

export interface VehicleContext {
  vehicle_id: string;
  make: string;
  model: string;
  year: number;
  engine: string | null;
}

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 1024;

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI advisor will return a stub reply');
    }
  }

  buildSystem(ctx: VehicleContext | null): string {
    const car = ctx
      ? `Foydalanuvchining avtomobili: ${ctx.make} ${ctx.model} ${ctx.year}` +
        (ctx.engine ? ` (${ctx.engine})` : '') + '.'
      : 'Foydalanuvchi avtomobil tanlamagan.';
    return [
      "Siz Mator ilovasining avtomobil bo'yicha AI maslahatchisisiz.",
      'Aniq, qisqa va amaliy javob bering. Asosan o\'zbek tilida javob bering.',
      car,
      "Tashxis taxminiy ekanini eslating va aniq tashxis uchun mexanikaga murojaat qilishni tavsiya qiling.",
    ].join(' ');
  }

  /** Stream assistant text deltas. Falls back to a stub when no API key. */
  async *streamReply(
    system: string,
    messages: Anthropic.MessageParam[],
  ): AsyncGenerator<string> {
    if (!this.client) {
      yield this.stub(messages);
      return;
    }
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  async fullReply(system: string, messages: Anthropic.MessageParam[]): Promise<string> {
    if (!this.client) return this.stub(messages);
    const msg = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  private stub(messages: Anthropic.MessageParam[]): string {
    const last = messages[messages.length - 1];
    const text =
      typeof last?.content === 'string'
        ? last.content
        : (last?.content?.find((b) => b.type === 'text') as { text?: string })?.text ?? '';
    return (
      `Savolingiz qabul qilindi: "${text.slice(0, 80)}". ` +
      'Bu test rejimidagi javob (ANTHROPIC_API_KEY sozlanmagan). ' +
      'Aniq tashxis uchun mexanikaga murojaat qiling.'
    );
  }
}
