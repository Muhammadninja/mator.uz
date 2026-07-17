import { maskPhone, maskEmail } from './pii.util';

describe('maskPhone', () => {
  it('keeps the country prefix and last two digits', () => {
    expect(maskPhone('+998901234567')).toBe('+998*******67');
  });

  it('does not reveal the full number', () => {
    const masked = maskPhone('+998901234567');
    expect(masked).not.toContain('90123456');
  });

  it('collapses short/empty values to ***', () => {
    expect(maskPhone('')).toBe('***');
    expect(maskPhone(null)).toBe('***');
    expect(maskPhone(undefined)).toBe('***');
    expect(maskPhone('+998')).toBe('***');
  });
});

describe('maskEmail', () => {
  it('keeps the first local char and the domain', () => {
    expect(maskEmail('akmal@example.com')).toBe('a***@example.com');
  });

  it('collapses invalid/empty values to ***', () => {
    expect(maskEmail('')).toBe('***');
    expect(maskEmail(null)).toBe('***');
    expect(maskEmail('noatsign')).toBe('***');
    expect(maskEmail('@nolocal.com')).toBe('***');
  });
});
