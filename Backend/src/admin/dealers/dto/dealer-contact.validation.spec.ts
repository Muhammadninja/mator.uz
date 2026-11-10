// LOW-ADM-013: dealer logo, email and phone are validated on create and update.

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAdminDealerDto } from './create-admin-dealer.dto';
import { UpdateAdminDealerDto } from './update-admin-dealer.dto';

const HOSTS = 'res.cloudinary.com';

async function errorsOf(
  dto: typeof CreateAdminDealerDto | typeof UpdateAdminDealerDto,
  body: Record<string, unknown>,
): Promise<string[]> {
  const base = dto === CreateAdminDealerDto ? { name: 'Dealer' } : {};
  const instance = plainToInstance(dto as new () => object, {
    ...base,
    ...body,
  });
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe.each([
  ['create', CreateAdminDealerDto],
  ['update', UpdateAdminDealerDto],
] as const)('dealer contact fields on %s', (_name, dto) => {
  const previous = process.env.ASSET_URL_ALLOWED_HOSTS;
  beforeAll(() => (process.env.ASSET_URL_ALLOWED_HOSTS = HOSTS));
  afterAll(() => {
    if (previous === undefined) delete process.env.ASSET_URL_ALLOWED_HOSTS;
    else process.env.ASSET_URL_ALLOWED_HOSTS = previous;
  });

  it('accepts an HTTPS logo on the allowed asset host, a valid email and an E.164 phone', async () => {
    expect(
      await errorsOf(dto, {
        logoUrl: 'https://res.cloudinary.com/mator/image/upload/v1/logo.png',
        email: 'sales@dealer.uz',
        phone: '+998901234567',
      }),
    ).toEqual([]);
  });

  it.each([
    'https://evil.example/logo.png',
    'http://res.cloudinary.com/mator/logo.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//res.cloudinary.com/mator/logo.png',
    'https://res.cloudinary.com.evil.example/logo.png',
  ])('rejects the logo URL %s', async (logoUrl) => {
    expect(await errorsOf(dto, { logoUrl })).toEqual(['logoUrl']);
  });

  it.each(['not-an-email', 'a@', '@b.uz', 'a b@c.uz'])(
    'rejects the email %j',
    async (email) => {
      expect(await errorsOf(dto, { email })).toEqual(['email']);
    },
  );

  it.each([
    '998901234567',
    '+0901234567',
    '+99890',
    'call me',
    '+9989012345678901',
  ])('rejects the phone %j', async (phone) => {
    expect(await errorsOf(dto, { phone })).toEqual(['phone']);
  });

  it('accepts a phone typed with spaces, dashes or parentheses and stores it canonical', () => {
    const instance = plainToInstance(dto as new () => object, {
      name: 'Dealer',
      phone: '+998 (90) 123-45-67',
    }) as { phone?: string };
    expect(instance.phone).toBe('+998901234567');
  });

  it('still lets the console clear a field with an empty string, or omit it', async () => {
    expect(await errorsOf(dto, { logoUrl: '', email: '', phone: '' })).toEqual(
      [],
    );
    expect(await errorsOf(dto, {})).toEqual([]);
  });

  it('refuses every logo when no asset host is configured (fail closed)', async () => {
    process.env.ASSET_URL_ALLOWED_HOSTS = '';
    try {
      expect(
        await errorsOf(dto, {
          logoUrl: 'https://res.cloudinary.com/mator/logo.png',
        }),
      ).toEqual(['logoUrl']);
    } finally {
      process.env.ASSET_URL_ALLOWED_HOSTS = HOSTS;
    }
  });
});
