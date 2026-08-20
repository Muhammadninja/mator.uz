// Validation tests for RequestOtpDto's `lang` field. Run through the same
// class-transformer + class-validator pipeline the global ValidationPipe uses
// (whitelist + forbidNonWhitelisted + transform), so what happens here is
// exactly what the /v1/auth/phone/request-otp endpoint does.

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RequestOtpDto } from './request-otp.dto';

function parse(body: Record<string, unknown>): {
  dto: RequestOtpDto;
  errors: string[];
} {
  const dto = plainToInstance(RequestOtpDto, body, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);
  return { dto, errors };
}

const base = { phone_e164: '+998901234567' };

describe('RequestOtpDto.lang', () => {
  it('accepts each supported language as-is', () => {
    for (const lang of ['en', 'ru', 'uz'] as const) {
      const { dto, errors } = parse({ ...base, lang });
      expect(errors).toEqual([]);
      expect(dto.lang).toBe(lang);
    }
  });

  it('leaves lang undefined when the client sends none', () => {
    const { dto, errors } = parse(base);
    expect(errors).toEqual([]);
    expect(dto.lang).toBeUndefined();
  });

  it('normalizes case and locale/script subtags before validating', () => {
    expect(parse({ ...base, lang: 'RU' }).dto.lang).toBe('ru');
    expect(parse({ ...base, lang: 'en-US' }).dto.lang).toBe('en');
    expect(parse({ ...base, lang: 'uz-Latn-UZ' }).dto.lang).toBe('uz');
  });

  it('degrades an unsupported language to uz instead of rejecting the request', () => {
    // A locale we have no copy for must never turn a login into a 400 — the user
    // still gets their code, in the default language.
    for (const lang of ['de', 'kk', 'zz-ZZ', '', 42, null]) {
      const { dto, errors } = parse({ ...base, lang });
      expect(errors).toEqual([]);
      expect(dto.lang === undefined || dto.lang === 'uz').toBe(true);
    }
  });

  it('still rejects an unknown property (forbidNonWhitelisted is on)', () => {
    expect(parse({ ...base, language: 'ru' }).errors).toEqual(['language']);
  });
});
