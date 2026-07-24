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
    (service as unknown as { provider: { name: string; send: jest.Mock } }).provider = {
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
    await service.sendSms('+998901234567', `Mator: tasdiqlash kodingiz ${code}.`, 'otp');
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

  it('does not record a row when the provider send fails', async () => {
    providerSend.mockRejectedValueOnce(new Error('gateway down'));
    await expect(service.sendSms('+998901234567', 'hi', 'otp')).rejects.toThrow('gateway down');
    expect(create).not.toHaveBeenCalled();
  });

  it('still resolves the send when the accounting insert throws (best-effort)', async () => {
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.sendSms('+998901234567', 'hi', 'otp')).resolves.toBeUndefined();
    expect(providerSend).toHaveBeenCalledTimes(1);
  });
});
