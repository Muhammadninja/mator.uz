import { SmsService } from './sms.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsOperatorResolver } from './resolver/sms-operator.resolver';
import { ConfigService } from '@nestjs/config';

// ConfigService with no SMS_* vars → SmsService picks the log provider. The
// provider is then overridden per test with a fake so we control the returned
// metadata without touching any real transport.
const makeConfig = () =>
  ({ get: jest.fn().mockReturnValue(undefined) }) as unknown as ConfigService;

describe('SmsService accounting', () => {
  let create: jest.Mock;
  let providerSend: jest.Mock;
  let service: SmsService;

  const lastCreatedData = () => create.mock.calls[0][0].data;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({});
    const prisma = { smsMessage: { create } } as unknown as PrismaService;
    const resolver = {
      resolve: jest.fn().mockResolvedValue({
        operatorId: 5,
        operatorName: 'beeline',
        priceUzs: 155,
      }),
    } as unknown as SmsOperatorResolver;

    service = new SmsService(makeConfig(), prisma, resolver);

    // Override the internally-constructed provider with a controllable fake that
    // reports Sayqal-style metadata.
    providerSend = jest.fn().mockResolvedValue({
      providerTransactionId: 'tx-1',
      providerSmsId: 'sms-1',
      parts: 3,
    });
    (
      service as unknown as { provider: { name: string; send: jest.Mock } }
    ).provider = {
      name: 'sayqal',
      send: providerSend,
    };
  });

  it('propagates provider metadata (transactionId / smsId / parts) into SmsMessage', async () => {
    await service.sendSms('+998901234567', 'code 123', 'otp');

    // Send path is unchanged: provider receives exactly (phone, text).
    expect(providerSend).toHaveBeenCalledWith('+998901234567', 'code 123');
    expect(create).toHaveBeenCalledTimes(1);

    expect(lastCreatedData()).toMatchObject({
      provider: 'sayqal',
      providerTransactionId: 'tx-1',
      providerSmsId: 'sms-1',
      parts: 3,
      phoneE164: '+998901234567',
      operatorId: 5,
      operatorName: 'beeline',
      priceUzs: 155,
      template: 'otp',
      status: 'pending',
    });
  });

  it('stores providerTransactionId', async () => {
    await service.sendSms('+998901234567', 'hi', 'otp');
    expect(lastCreatedData().providerTransactionId).toBe('tx-1');
  });

  it('stores providerSmsId', async () => {
    await service.sendSms('+998901234567', 'hi', 'otp');
    expect(lastCreatedData().providerSmsId).toBe('sms-1');
  });

  it('stores parts', async () => {
    await service.sendSms('+998901234567', 'hi', 'otp');
    expect(lastCreatedData().parts).toBe(3);
  });

  it('records template="otp" for OTP sends', async () => {
    await service.sendSms('+998901234567', 'code', 'otp');
    expect(lastCreatedData().template).toBe('otp');
  });

  it('never persists the rendered SMS text or the OTP code', async () => {
    // Code chosen so it is not a coincidental substring of the phone number.
    const code = '424242';
    await service.sendSms(
      '+998901234567',
      `Mator: tasdiqlash kodingiz ${code}.`,
      'otp',
    );
    const serialized = JSON.stringify(lastCreatedData());
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain('tasdiqlash');
  });

  it('defaults template to null for legacy 2-argument callers (backward compatible)', async () => {
    await service.sendSms('+998901234567', 'hi');
    expect(providerSend).toHaveBeenCalledWith('+998901234567', 'hi');
    expect(lastCreatedData().template).toBeNull();
  });

  it('persists null metadata when the provider exposes none', async () => {
    providerSend.mockResolvedValueOnce({
      providerTransactionId: null,
      providerSmsId: null,
      parts: null,
    });

    await service.sendSms('+998901234567', 'hi', 'otp');

    expect(lastCreatedData()).toMatchObject({
      providerTransactionId: null,
      providerSmsId: null,
      parts: null,
    });
  });

  it('coerces a string `parts` from a misbehaving provider so the row still writes', async () => {
    // Regression: Sayqal returns parts as the string "1". Prisma's `parts Int?`
    // rejected it, the create() threw, and the accounting row — including the
    // price snapshot the SMS cost metrics sum — was silently lost.
    providerSend.mockResolvedValueOnce({
      providerTransactionId: 'tx-1',
      providerSmsId: 'sms-1',
      parts: '1' as unknown as number,
    });

    await service.sendSms('+998901234567', 'hi', 'otp');

    expect(lastCreatedData().parts).toBe(1);
  });

  it('writes null for an unparseable `parts` instead of losing the whole row', async () => {
    providerSend.mockResolvedValueOnce({
      providerTransactionId: 'tx-2',
      providerSmsId: 'sms-2',
      parts: 'abc' as unknown as number,
    });

    await service.sendSms('+998901234567', 'hi', 'otp');

    expect(create).toHaveBeenCalledTimes(1);
    expect(lastCreatedData().parts).toBeNull();
  });

  it('does not record a row when the provider send fails', async () => {
    providerSend.mockRejectedValueOnce(new Error('gateway down'));
    await expect(service.sendSms('+998901234567', 'hi', 'otp')).rejects.toThrow(
      'gateway down',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('still resolves the send when the accounting insert throws (best-effort)', async () => {
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.sendSms('+998901234567', 'hi', 'otp'),
    ).resolves.toBeUndefined();
    expect(providerSend).toHaveBeenCalledTimes(1);
  });
});

describe('SmsService provider selection (Eskiz fail-fast)', () => {
  const prisma = {
    smsMessage: { create: jest.fn() },
  } as unknown as PrismaService;
  const resolver = { resolve: jest.fn() } as unknown as SmsOperatorResolver;

  /** ConfigService backed by a plain env map. */
  const configOf = (env: Record<string, string | undefined>) =>
    ({ get: jest.fn((key: string) => env[key]) }) as unknown as ConfigService;

  const build = (env: Record<string, string | undefined>) =>
    new SmsService(configOf(env), prisma, resolver);

  const providerName = (svc: SmsService) =>
    (svc as unknown as { provider: { name: string } }).provider.name;

  it('throws in production when SMS_PROVIDER=eskiz and credentials are missing', () => {
    expect(() =>
      build({ NODE_ENV: 'production', SMS_PROVIDER: 'eskiz' }),
    ).toThrow(/requires ESKIZ_EMAIL and ESKIZ_PASSWORD in production/);
  });

  it('throws in production when only ESKIZ_PASSWORD is missing', () => {
    expect(() =>
      build({
        NODE_ENV: 'production',
        SMS_PROVIDER: 'eskiz',
        ESKIZ_EMAIL: 'bot@mator.uz',
      }),
    ).toThrow(/requires ESKIZ_EMAIL and ESKIZ_PASSWORD/);
  });

  it('throws in production when only ESKIZ_EMAIL is missing', () => {
    expect(() =>
      build({
        NODE_ENV: 'production',
        SMS_PROVIDER: 'eskiz',
        ESKIZ_PASSWORD: 'secret',
      }),
    ).toThrow(/requires ESKIZ_EMAIL and ESKIZ_PASSWORD/);
  });

  it('boots the eskiz provider in production when both credentials are present', () => {
    const svc = build({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'eskiz',
      ESKIZ_EMAIL: 'bot@mator.uz',
      ESKIZ_PASSWORD: 'secret',
    });
    expect(providerName(svc)).toBe('eskiz');
  });

  it('keeps the log fallback outside production (dev must never hard-fail)', () => {
    expect(
      providerName(build({ NODE_ENV: 'development', SMS_PROVIDER: 'eskiz' })),
    ).toBe('log');
    // NODE_ENV unset (bare `jest` run) must behave like dev, not production.
    expect(providerName(build({ SMS_PROVIDER: 'eskiz' }))).toBe('log');
  });

  it('does not fail-fast for other providers, even in production', () => {
    expect(
      providerName(
        build({ NODE_ENV: 'production', SMS_PROVIDER: 'playmobile' }),
      ),
    ).toBe('log');
    expect(
      providerName(build({ NODE_ENV: 'production', SMS_PROVIDER: 'sayqal' })),
    ).toBe('log');
    expect(providerName(build({ NODE_ENV: 'production' }))).toBe('log');
  });
});

describe('SmsService.applyEskizCallback', () => {
  let updateMany: jest.Mock;
  let service: SmsService;

  const lastWhere = () => updateMany.mock.calls[0][0].where as Record<string, unknown>;
  const lastData = () => updateMany.mock.calls[0][0].data as Record<string, unknown>;

  beforeEach(() => {
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { smsMessage: { updateMany } } as unknown as PrismaService;
    const resolver = { resolve: jest.fn() } as unknown as SmsOperatorResolver;
    service = new SmsService(makeConfig(), prisma, resolver);
  });

  it('closes the pending row as delivered and stamps deliveredAt', async () => {
    const res = await service.applyEskizCallback({ messageId: 'msg-1', status: 'delivered' });

    expect(res).toEqual({ outcome: 'updated', status: 'delivered' });
    expect(lastData().status).toBe('delivered');
    expect(lastData().deliveredAt).toBeInstanceOf(Date);
    expect(lastData().errorMessage).toBeNull();
  });

  it('scopes the update to eskiz + the exact id + a still-pending row', async () => {
    await service.applyEskizCallback({ messageId: 'msg-1', status: 'delivered' });

    // provider scoping stops another aggregator's colliding id from being
    // rewritten; status:'pending' makes a duplicate report a no-op.
    expect(lastWhere()).toEqual({
      provider: 'eskiz',
      providerSmsId: 'msg-1',
      status: 'pending',
    });
  });

  it('records a failure with its reason and no deliveredAt', async () => {
    const res = await service.applyEskizCallback({
      messageId: 'msg-2',
      status: 'rejected',
      error: 'blocked by operator',
    });

    expect(res).toEqual({ outcome: 'updated', status: 'failed' });
    expect(lastData().status).toBe('failed');
    expect(lastData().deliveredAt).toBeNull();
    expect(lastData().errorMessage).toBe('blocked by operator');
  });

  it('keeps undelivered distinct from failed', async () => {
    const res = await service.applyEskizCallback({ messageId: 'msg-3', status: 'expired' });

    expect(res.status).toBe('undelivered');
    expect(lastData().status).toBe('undelivered');
  });

  it('falls back to the raw status as errorMessage when no error text is given', async () => {
    await service.applyEskizCallback({ messageId: 'msg-4', status: 'failed' });
    expect(lastData().errorMessage).toBe('failed');
  });

  it('is idempotent: a duplicate report matches no pending row and reports no_match', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await service.applyEskizCallback({ messageId: 'msg-5', status: 'delivered' });

    expect(res).toEqual({ outcome: 'no_match', status: 'delivered' });
  });

  it('ignores a payload with no message id and never touches the DB', async () => {
    const res = await service.applyEskizCallback({ status: 'delivered' });

    expect(res).toEqual({ outcome: 'ignored', reason: 'missing_message_id' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('leaves the row pending on an interim status', async () => {
    const res = await service.applyEskizCallback({ messageId: 'msg-6', status: 'waiting' });

    expect(res).toEqual({ outcome: 'ignored', reason: 'interim_status' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('leaves the row pending on an unrecognised status rather than mislabelling it', async () => {
    const res = await service.applyEskizCallback({ messageId: 'msg-7', status: 'martian' });

    expect(res).toEqual({ outcome: 'ignored', reason: 'unknown_status' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('swallows a DB failure so the webhook can still answer 200', async () => {
    updateMany.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.applyEskizCallback({ messageId: 'msg-8', status: 'delivered' }),
    ).resolves.toEqual({ outcome: 'error' });
  });

  it('trims a padded message id before matching', async () => {
    await service.applyEskizCallback({ messageId: '  msg-9  ', status: 'delivered' });
    expect(lastWhere().providerSmsId).toBe('msg-9');
  });
});
