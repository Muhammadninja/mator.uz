import { isAllowedAssetUrl } from './asset-url.util';

describe('isAllowedAssetUrl', () => {
  const allow = ['cloudinary.com', 'cdn.mator.uz'];

  it('accepts an exact allowlisted host over HTTPS', () => {
    expect(isAllowedAssetUrl('https://cdn.mator.uz/a/b.png', allow)).toBe(true);
  });

  it('accepts a subdomain of an allowlisted host', () => {
    expect(isAllowedAssetUrl('https://res.cloudinary.com/demo/image/x.jpg', allow)).toBe(true);
  });

  it('is case-insensitive on the host', () => {
    expect(isAllowedAssetUrl('https://RES.Cloudinary.COM/x.jpg', allow)).toBe(true);
  });

  it('rejects non-HTTPS schemes', () => {
    expect(isAllowedAssetUrl('http://cdn.mator.uz/a.png', allow)).toBe(false);
    expect(isAllowedAssetUrl('ftp://cdn.mator.uz/a.png', allow)).toBe(false);
  });

  it('rejects hosts not on the allowlist', () => {
    expect(isAllowedAssetUrl('https://evil.example.com/a.png', allow)).toBe(false);
  });

  it('rejects a look-alike host that only ends with the allowed string', () => {
    // "notcloudinary.com" must NOT match "cloudinary.com".
    expect(isAllowedAssetUrl('https://notcloudinary.com/a.png', allow)).toBe(false);
    expect(isAllowedAssetUrl('https://evilcloudinary.com/a.png', allow)).toBe(false);
  });

  it('rejects an allowed host used as a subdomain of an attacker domain', () => {
    // The classic bypass: the real host is *.evil.com, the allowlisted string is
    // only an internal label. Matching must be on the parsed hostname with a
    // dot-anchored suffix, not includes()/bare endsWith().
    expect(isAllowedAssetUrl('https://res.cloudinary.com.evil.com/a.png', allow)).toBe(false);
    expect(isAllowedAssetUrl('https://cloudinary.com.evil.com/a.png', allow)).toBe(false);
    expect(isAllowedAssetUrl('https://cdn.mator.uz.evil.com/a.png', allow)).toBe(false);
  });

  it('rejects an allowed host smuggled into userinfo or path (real host is elsewhere)', () => {
    // new URL().hostname resolves to the true authority host, so the allowed
    // string appearing in the userinfo/path must NOT grant access.
    expect(isAllowedAssetUrl('https://res.cloudinary.com@evil.com/a.png', allow)).toBe(false);
    expect(isAllowedAssetUrl('https://evil.com/res.cloudinary.com/a.png', allow)).toBe(false);
    expect(isAllowedAssetUrl('https://evil.com/?x=cloudinary.com', allow)).toBe(false);
  });

  it('accepts the allowlisted host even with a port or userinfo of its own', () => {
    // Positive control: hostname is compared, so port/userinfo don't break a
    // legitimately-allowed host.
    expect(isAllowedAssetUrl('https://res.cloudinary.com:443/a.png', allow)).toBe(true);
  });

  it('fails closed on empty allowlist', () => {
    expect(isAllowedAssetUrl('https://cdn.mator.uz/a.png', [])).toBe(false);
  });

  it('rejects malformed / non-string values', () => {
    expect(isAllowedAssetUrl('not a url', allow)).toBe(false);
    expect(isAllowedAssetUrl('', allow)).toBe(false);
    expect(isAllowedAssetUrl(undefined, allow)).toBe(false);
    expect(isAllowedAssetUrl(123 as unknown, allow)).toBe(false);
  });
});
