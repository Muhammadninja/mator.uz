import { UnauthorizedException } from '@nestjs/common';
import { JwtUnlessAnonymousGuard } from '../auth/guards/optional-jwt-auth.guard';
import { SourcingCapabilitiesController } from '../sourcing/sourcing-capabilities.controller';

const context = (authorization?: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }) }) as never;

describe('JwtUnlessAnonymousGuard', () => {
  const guard = new JwtUnlessAnonymousGuard();

  it('no token is a guest', () => {
    expect(guard.handleRequest(null, false as never, null, context())).toBeNull();
  });
  it('a valid token is that user', () => {
    const user = { id: 'u1' };
    expect(guard.handleRequest(null, user, null, context('Bearer ok'))).toBe(user);
  });
  it('a token that fails is 401, not a guest', () => {
    expect(() => guard.handleRequest(null, false as never, null, context('Bearer bad'))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('SourcingCapabilitiesController', () => {
  it.each([true, false])('reports the switch as %s', (ticketsEnabled) => {
    const reply = new SourcingCapabilitiesController({ ticketsEnabled } as never).capabilities();
    expect(reply).toMatchObject({ contract_version: 2, ticket_submission_enabled: ticketsEnabled });
  });
});
