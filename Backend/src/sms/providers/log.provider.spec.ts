import { LogSmsProvider } from './log.provider';

describe('LogSmsProvider', () => {
  it('returns all-null send metadata (nothing was actually delivered)', async () => {
    const result = await new LogSmsProvider().send('+998901234567', 'hi');

    expect(result).toEqual({
      providerTransactionId: null,
      providerSmsId: null,
      parts: null,
    });
  });
});
