import {
  DEALER_API_KEY_PREFIX,
  generateDealerApiKey,
  hashDealerApiKey,
  safeEqualHex,
} from './api-key.util';

describe('api-key.util', () => {
  it('issues a prefixed, high-entropy, unique key each time', () => {
    const keys = new Set(
      Array.from({ length: 200 }, () => generateDealerApiKey().rawKey),
    );

    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key.startsWith(DEALER_API_KEY_PREFIX)).toBe(true);
      expect(key.length).toBeGreaterThan(40);
    }
  });

  it('returns a digest that matches the key, and a last4 that is its suffix', () => {
    const { rawKey, hash, last4 } = generateDealerApiKey();

    expect(hash).toBe(hashDealerApiKey(rawKey));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(last4).toBe(rawKey.slice(-4));
  });

  it('hashes deterministically, so the guard can look a dealer up by digest', () => {
    expect(hashDealerApiKey('mtr_live_abc')).toBe(
      hashDealerApiKey('mtr_live_abc'),
    );
    expect(hashDealerApiKey('mtr_live_abc')).not.toBe(
      hashDealerApiKey('mtr_live_abd'),
    );
  });

  describe('safeEqualHex', () => {
    const digest = hashDealerApiKey('key');

    it('compares equal and unequal digests correctly', () => {
      expect(safeEqualHex(digest, digest)).toBe(true);
      expect(safeEqualHex(digest, hashDealerApiKey('other'))).toBe(false);
    });

    it('rejects NON-HEX input rather than reporting it equal', () => {
      // Buffer.from(s,'hex') stops at the first invalid char, so two different
      // non-hex strings both decode to an empty buffer — which timingSafeEqual
      // would otherwise call EQUAL.
      expect(safeEqualHex('z'.repeat(64), 'z'.repeat(64))).toBe(false);
      expect(safeEqualHex('', '')).toBe(false);
      expect(safeEqualHex('abc', 'abd')).toBe(false);
    });

    it('rejects a digest of the wrong length', () => {
      expect(safeEqualHex(digest.slice(0, 62), digest.slice(0, 62))).toBe(
        false,
      );
      expect(safeEqualHex(digest, digest.slice(0, 62))).toBe(false);
    });
  });
});
