// Tests for the HTTP correlation id: generation, sanitizing of untrusted
// inbound values, and propagation through the async call tree.
//
// The propagation tests are the important ones. The whole design rests on an
// audit write three calls deep seeing the id without anyone passing it, so
// these assert that it survives `await`, concurrency, and absence of a context.

import {
  generateRequestId,
  getRequestId,
  runWithRequestId,
  sanitizeRequestId,
} from './request-context';

describe('generateRequestId', () => {
  it('produces a short uppercase hex id', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRequestId()).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it('does not repeat across many calls', () => {
    const ids = new Set(Array.from({ length: 500 }, generateRequestId));
    // 16.7M space; 500 draws colliding would indicate a broken generator.
    expect(ids.size).toBeGreaterThan(495);
  });
});

describe('sanitizeRequestId', () => {
  it('accepts a well-formed inbound id', () => {
    expect(sanitizeRequestId('3AA7FC')).toBe('3AA7FC');
    expect(sanitizeRequestId('trace-abc_123.4')).toBe('trace-abc_123.4');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeRequestId('  3AA7FC \n')).toBe('3AA7FC');
  });

  it('strips characters that could forge a log line', () => {
    // A newline in a value that gets logged lets an attacker inject a fake
    // entry; it must never survive.
    expect(sanitizeRequestId('abc\ndef')).toBe('abcdef');
    expect(sanitizeRequestId('abc\r\n[FAKE] error')).toBe('abcFAKEerror');
    expect(sanitizeRequestId('a b\tc')).toBe('abc');
  });

  it('caps an oversized inbound id', () => {
    expect(sanitizeRequestId('x'.repeat(500))).toHaveLength(64);
  });

  it.each([
    ['a non-string', 12345],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['only stripped characters', '!!!///'],
    ['an array (duplicate header)', ['a', 'b']],
  ])('returns null for %s', (_label, value) => {
    expect(sanitizeRequestId(value)).toBeNull();
  });
});

describe('request context propagation', () => {
  it('exposes the id inside the scope', () => {
    runWithRequestId('3AA7FC', () => {
      expect(getRequestId()).toBe('3AA7FC');
    });
  });

  it('returns undefined outside any scope', () => {
    // Queue workers, cron jobs and the Telegram bot run with no context — this
    // must never throw.
    expect(getRequestId()).toBeUndefined();
  });

  it('survives await boundaries', async () => {
    await runWithRequestId('ABC123', async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(getRequestId()).toBe('ABC123');
    });
  });

  it('reaches a callee several levels deep without being passed', async () => {
    // The property the audit trail depends on.
    const deep = async () => {
      await Promise.resolve();
      return getRequestId();
    };
    const middle = async () => deep();
    const top = async () => middle();

    await runWithRequestId('DEEP01', async () => {
      await expect(top()).resolves.toBe('DEEP01');
    });
  });

  it('keeps concurrent requests isolated', async () => {
    // Two overlapping requests must never see each other's id.
    const run = (id: string, delay: number) =>
      runWithRequestId(id, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return getRequestId();
      });

    await expect(
      Promise.all([run('AAA111', 5), run('BBB222', 1)]),
    ).resolves.toEqual(['AAA111', 'BBB222']);
  });

  it('does not leak out of the scope', async () => {
    await runWithRequestId('CCC333', async () => Promise.resolve());
    expect(getRequestId()).toBeUndefined();
  });
});
