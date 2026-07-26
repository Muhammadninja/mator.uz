// Validation tests for the admin auth DTOs — the system boundary where
// untrusted input enters. Uses the same plainToInstance + validateSync pair the
// global ValidationPipe applies, so a rejection here is a real 400.

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminLoginDto } from './admin-login.dto';
import { AdminRefreshDto } from './admin-refresh.dto';

const validate = <T extends object>(cls: new () => T, payload: unknown) =>
  validateSync(plainToInstance(cls, payload) as object);

describe('AdminLoginDto', () => {
  it('accepts a well-formed email + password', () => {
    expect(
      validate(AdminLoginDto, {
        email: 'admin@example.com',
        password: 'password123',
      }),
    ).toHaveLength(0);
  });

  it('normalizes the email to trimmed lowercase', () => {
    const dto = plainToInstance(AdminLoginDto, {
      email: '  Admin@Example.COM  ',
      password: 'password123',
    });
    expect(dto.email).toBe('admin@example.com');
  });

  it.each([
    ['a missing email', { password: 'password123' }],
    ['a malformed email', { email: 'not-an-email', password: 'password123' }],
    ['a missing password', { email: 'admin@example.com' }],
    [
      'a password under 8 chars',
      { email: 'admin@example.com', password: 'short' },
    ],
    // bcrypt ignores bytes past 72 — a longer input must be refused, not silently truncated.
    [
      'a password over 72 chars',
      { email: 'admin@example.com', password: 'x'.repeat(73) },
    ],
    [
      'a non-string password',
      { email: 'admin@example.com', password: 12345678 },
    ],
  ])('rejects %s', (_label, payload) => {
    expect(validate(AdminLoginDto, payload).length).toBeGreaterThan(0);
  });
});

describe('AdminRefreshDto', () => {
  it('accepts an opaque refresh token', () => {
    expect(
      validate(AdminRefreshDto, { refreshToken: `art_${'a'.repeat(43)}` }),
    ).toHaveLength(0);
  });

  it.each([
    ['a missing token', {}],
    ['an empty token', { refreshToken: '' }],
    ['a non-string token', { refreshToken: { evil: true } }],
    ['an oversized token', { refreshToken: 'a'.repeat(513) }],
  ])('rejects %s', (_label, payload) => {
    expect(validate(AdminRefreshDto, payload).length).toBeGreaterThan(0);
  });
});
