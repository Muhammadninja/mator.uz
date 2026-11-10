// LOW-ADM-012: password hashing is memory-hard (64 MiB per operation), so the
// number running at once and the number waiting are both bounded.

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
  verify: jest.fn(),
}));

import * as argon2 from 'argon2';
import {
  PasswordKdfBusyError,
  hashPassword,
  passwordKdfStats,
  resetPasswordKdfGate,
  verifyPassword,
} from './password.util';

const verify = argon2.verify as unknown as jest.Mock;
const hash = argon2.hash as unknown as jest.Mock;
const tick = () => new Promise((r) => setImmediate(r));

describe('password KDF gate', () => {
  let release: ((ok: boolean) => void)[];
  let running: number;
  let peak: number;

  beforeEach(() => {
    process.env.PASSWORD_KDF_CONCURRENCY = '2';
    process.env.PASSWORD_KDF_MAX_QUEUE = '3';
    resetPasswordKdfGate();
    release = [];
    running = 0;
    peak = 0;
    verify.mockReset().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          running++;
          peak = Math.max(peak, running);
          release.push((ok) => {
            running--;
            resolve(ok);
          });
        }),
    );
    hash.mockReset().mockResolvedValue('$argon2id$hash');
  });

  afterAll(() => {
    delete process.env.PASSWORD_KDF_CONCURRENCY;
    delete process.env.PASSWORD_KDF_MAX_QUEUE;
    resetPasswordKdfGate();
  });

  it('never runs more verifications at once than configured, however many bad logins arrive', async () => {
    const attempts = Array.from({ length: 5 }, () =>
      verifyPassword('$argon2id$x', 'wrong'),
    );
    await tick();
    expect(running).toBe(2);
    expect(passwordKdfStats()).toMatchObject({ active: 2, waiting: 3 });

    // Drain: each finished operation admits exactly one waiter.
    while (release.length) {
      release.shift()!(false);
      await tick();
      expect(running).toBeLessThanOrEqual(2);
    }
    await expect(Promise.all(attempts)).resolves.toEqual(Array(5).fill(false));
    expect(peak).toBe(2);
    expect(passwordKdfStats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('answers a full queue with a controlled 503 instead of queueing without bound', async () => {
    const admitted = Array.from({ length: 5 }, () =>
      verifyPassword('$argon2id$x', 'wrong'),
    );
    await tick();

    const overflow = verifyPassword('$argon2id$x', 'wrong');
    await expect(overflow).rejects.toBeInstanceOf(PasswordKdfBusyError);
    await expect(overflow).rejects.toMatchObject({ status: 503 });
    // Refused before any work: the KDF was not started for it.
    expect(verify).toHaveBeenCalledTimes(2);

    while (release.length) {
      release.shift()!(false);
      await tick();
    }
    await Promise.all(admitted);
  });

  it('a successful login still verifies, and a password change still hashes', async () => {
    const ok = verifyPassword('$argon2id$x', 'right');
    await tick();
    release.shift()!(true);
    await expect(ok).resolves.toBe(true);
    await expect(hashPassword('new-password')).resolves.toBe('$argon2id$hash');
  });

  it('hashing shares the same limit as verification', async () => {
    const hashRelease: (() => void)[] = [];
    hash.mockImplementation(
      () => new Promise<string>((r) => hashRelease.push(() => r('h'))),
    );
    const a = verifyPassword('$argon2id$x', 'p');
    const b = hashPassword('p');
    const c = hashPassword('p');
    await tick();
    expect(verify.mock.calls.length + hash.mock.calls.length).toBe(2);
    release.shift()!(true);
    await tick();
    expect(hash).toHaveBeenCalledTimes(2);
    hashRelease.forEach((r) => r());
    await Promise.all([a, b, c]);
  });

  it('frees its slot when the KDF throws, and an unknown hash format costs nothing', async () => {
    verify.mockRejectedValueOnce(new Error('malformed hash'));
    await expect(verifyPassword('$argon2id$bad', 'p')).resolves.toBe(false);
    expect(passwordKdfStats()).toMatchObject({ active: 0 });

    await expect(verifyPassword('plaintext', 'p')).resolves.toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('clamps configured limits and falls back on nonsense', () => {
    process.env.PASSWORD_KDF_CONCURRENCY = '9999';
    process.env.PASSWORD_KDF_MAX_QUEUE = 'lots';
    resetPasswordKdfGate();
    expect(passwordKdfStats()).toMatchObject({ concurrency: 16, maxQueue: 8 });
  });
});
