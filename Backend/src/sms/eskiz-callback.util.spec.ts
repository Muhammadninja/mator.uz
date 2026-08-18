import { mapEskizStatus, isInterimStatus } from './eskiz-callback.util';

describe('mapEskizStatus', () => {
  it('maps delivered spellings (including Eskiz\'s "DELIVRD")', () => {
    expect(mapEskizStatus('delivered')).toBe('delivered');
    expect(mapEskizStatus('DELIVERED')).toBe('delivered');
    expect(mapEskizStatus('DELIVRD')).toBe('delivered');
  });

  it('maps outright failures', () => {
    expect(mapEskizStatus('failed')).toBe('failed');
    expect(mapEskizStatus('rejected')).toBe('failed');
  });

  it('keeps undelivered distinct from failed (it was accepted and billed)', () => {
    expect(mapEskizStatus('undelivered')).toBe('undelivered');
    expect(mapEskizStatus('not_delivered')).toBe('undelivered');
    expect(mapEskizStatus('expired')).toBe('undelivered');
  });

  it('normalises case, whitespace, and separators', () => {
    expect(mapEskizStatus('  Not-Delivered ')).toBe('undelivered');
    expect(mapEskizStatus('NOT DELIVERED')).toBe('undelivered');
  });

  it('returns null for interim, unknown, and empty statuses', () => {
    expect(mapEskizStatus('waiting')).toBeNull();
    expect(mapEskizStatus('something-new')).toBeNull();
    expect(mapEskizStatus('')).toBeNull();
    expect(mapEskizStatus(undefined)).toBeNull();
    expect(mapEskizStatus(null)).toBeNull();
  });
});

describe('isInterimStatus', () => {
  it('recognises in-flight statuses', () => {
    expect(isInterimStatus('waiting')).toBe(true);
    expect(isInterimStatus('Accepted')).toBe(true);
    expect(isInterimStatus('transmitted')).toBe(true);
  });

  it('does not treat terminal or unknown statuses as interim', () => {
    expect(isInterimStatus('delivered')).toBe(false);
    expect(isInterimStatus('failed')).toBe(false);
    expect(isInterimStatus('who-knows')).toBe(false);
    expect(isInterimStatus(undefined)).toBe(false);
  });
});
