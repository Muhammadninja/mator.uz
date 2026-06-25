import { BadRequestException } from '@nestjs/common';
import { AuthController } from '../../src/auth/auth.controller';
import { ACCESS_TTL_SECONDS } from '../../src/auth/tokens/token.service';

/** Build the consolidated AuthController with only the collaborators each test
 * needs; the rest are inert stubs. */
function makeController(over: {
  auth?: any;
  phoneAuth?: any;
  myId?: any;
  tokens?: any;
} = {}) {
  return new AuthController(
    over.auth ?? ({} as any),
    over.phoneAuth ?? ({} as any),
    over.myId ?? ({} as any),
    over.tokens ?? ({} as any),
  );
}

describe('Auth compatibility aliases (consolidated AuthController)', () => {
  it('sign-in delegates to AuthService.login and reshapes to the camelCase contract', async () => {
    const auth = {
      login: jest.fn().mockResolvedValue({
        user: { id: 'usr_1', email: 'a@b.uz' },
        accessToken: 'a.b.c',
        refreshToken: 'rt_x',
      }),
    };
    const ctrl = makeController({ auth });

    const res: any = await ctrl.signIn({ email: 'a@b.uz', password: 'Secret123!' } as any);

    expect(auth.login).toHaveBeenCalledWith({ email: 'a@b.uz', password: 'Secret123!' });
    expect(res).toEqual({
      accessToken: 'a.b.c',
      refreshToken: 'rt_x',
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: 'usr_1', email: 'a@b.uz' },
    });
  });

  it('sign-up delegates to AuthService.register (no tokens issued, Variant A)', async () => {
    const auth = {
      register: jest.fn().mockResolvedValue({
        message: 'check your email',
        email: 'a@b.uz',
        emailVerified: false,
      }),
    };
    const ctrl = makeController({ auth });

    const res: any = await ctrl.signUp({ email: 'a@b.uz', password: 'Secret123!', firstName: 'A' } as any);

    expect(auth.register).toHaveBeenCalledWith({
      email: 'a@b.uz',
      password: 'Secret123!',
      firstName: 'A',
      lastName: undefined,
    });
    expect(res.emailVerified).toBe(false);
    expect(res.accessToken).toBeUndefined();
  });

  it('refresh rotates the token and returns expiresIn (camelCase body)', async () => {
    const tokens = {
      rotate: jest.fn().mockResolvedValue({ accessToken: 'new.a.t', refreshToken: 'rt_new' }),
    };
    const ctrl = makeController({ tokens });

    const res: any = await ctrl.refresh({ refreshToken: 'rt_old' } as any);

    expect(tokens.rotate).toHaveBeenCalledWith('rt_old');
    expect(res).toEqual({ accessToken: 'new.a.t', refreshToken: 'rt_new', expiresIn: ACCESS_TTL_SECONDS });
  });

  it('refresh also accepts the snake_case body key', async () => {
    const tokens = {
      rotate: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'b' }),
    };
    const ctrl = makeController({ tokens });
    await ctrl.refresh({ refresh_token: 'rt_snake' } as any);
    expect(tokens.rotate).toHaveBeenCalledWith('rt_snake');
  });

  it('refresh rejects when neither body key is present', async () => {
    const ctrl = makeController({ tokens: { rotate: jest.fn() } });
    await expect(ctrl.refresh({} as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('token/refresh preserves the snake_case full-envelope response', async () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const tokens = {
      rotate: jest.fn().mockResolvedValue({
        accessToken: 'a.t',
        accessTokenExpiresAt: now,
        refreshToken: 'rt_n',
        refreshTokenExpiresAt: now,
        tokenType: 'Bearer',
      }),
    };
    const ctrl = makeController({ tokens });

    const res: any = await ctrl.tokenRefresh({ refresh_token: 'rt_old' } as any);

    expect(res).toEqual({
      access_token: 'a.t',
      access_token_expires_at: now.toISOString(),
      refresh_token: 'rt_n',
      refresh_token_expires_at: now.toISOString(),
      token_type: 'Bearer',
    });
  });

  it('sign-out revokes the refresh token (204, no body)', async () => {
    const tokens = { revoke: jest.fn().mockResolvedValue(undefined) };
    const ctrl = makeController({ tokens });

    const res = await ctrl.signOut({ refresh_token: 'rt_x' } as any);

    expect(tokens.revoke).toHaveBeenCalledWith('rt_x');
    expect(res).toBeUndefined();
  });

  it('logout revokes and returns a message', async () => {
    const tokens = { revoke: jest.fn().mockResolvedValue(undefined) };
    const ctrl = makeController({ tokens });

    const res: any = await ctrl.logout({ refreshToken: 'rt_x' } as any);

    expect(tokens.revoke).toHaveBeenCalledWith('rt_x');
    expect(res).toEqual({ message: 'Logged out successfully' });
  });
});
