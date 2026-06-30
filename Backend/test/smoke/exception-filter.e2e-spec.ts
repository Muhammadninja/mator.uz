import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';

function mockHost(headersSent = false) {
  const res: any = {
    headersSent,
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const req: any = { method: 'GET', url: '/test' };
  const host: any = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  };
  return { host, res };
}

describe('HttpExceptionFilter smoke', () => {
  const filter = new HttpExceptionFilter();

  it('maps a validation error (string[] message) to VALIDATION_FAILED + first message', () => {
    const { host, res } = mockHost();
    filter.catch(
      new BadRequestException({ statusCode: 400, message: ['email must be an email', 'x'], error: 'Bad Request' }),
      host,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.message).toBe('email must be an email');
  });

  it('maps 401 to UNAUTHORIZED', () => {
    const { host, res } = mockHost();
    filter.catch(new UnauthorizedException(), host);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(typeof res.body.message).toBe('string');
  });

  it('maps 403 to FORBIDDEN', () => {
    const { host, res } = mockHost();
    filter.catch(new ForbiddenException(), host);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('maps 404 to NOT_FOUND', () => {
    const { host, res } = mockHost();
    filter.catch(new NotFoundException(), host);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('honors an explicit business code thrown by the handler', () => {
    const { host, res } = mockHost();
    filter.catch(
      new ForbiddenException({ statusCode: 403, error: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email.' }),
      host,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.body.message).toBe('Please verify your email.');
  });

  it('maps an unknown (non-HTTP) error to a 500 INTERNAL_ERROR', () => {
    const { host, res } = mockHost();
    filter.catch(new Error('boom'), host);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
  });

  it('preserves a custom HTTP status (429 -> TOO_MANY_REQUESTS)', () => {
    const { host, res } = mockHost();
    filter.catch(new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS), host);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('TOO_MANY_REQUESTS');
    expect(res.body.message).toBe('slow down');
  });

  it('does not write a body when headers were already sent (SSE)', () => {
    const { host, res } = mockHost(true);
    filter.catch(new Error('after stream'), host);
    expect(res.statusCode).toBe(0);
    expect(res.body).toBeUndefined();
  });
});
