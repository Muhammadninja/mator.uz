import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { verifyOperatorToken } from './blueprint-auth';

/**
 * Gates the blueprint HTTP endpoints on the server-to-server operator token
 * (`x-blueprint-token`). The admin's server-side proxy holds the token and
 * injects it; the browser never sees it. Fails closed when `BLUEPRINT_TOKEN`
 * is unset (see {@link verifyOperatorToken}).
 */
@Injectable()
export class BlueprintTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-blueprint-token'];
    const token = Array.isArray(header) ? header[0] : header;
    return verifyOperatorToken(token);
  }
}
