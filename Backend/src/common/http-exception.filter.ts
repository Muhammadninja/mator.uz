import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** Stable machine-readable error codes the mobile client switches on. */
const STATUS_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.GONE]: 'GONE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
};

const DEFAULT_MESSAGE: Record<string, string> = {
  VALIDATION_FAILED: 'Invalid request.',
  UNAUTHORIZED: 'Authentication required.',
  FORBIDDEN: 'Access denied.',
  NOT_FOUND: 'Resource not found.',
  CONFLICT: 'Conflict.',
  GONE: 'Resource is no longer available.',
  TOO_MANY_REQUESTS: 'Too many requests.',
  INTERNAL_ERROR: 'Internal server error.',
};

interface ErrorBody {
  code: string;
  message: string;
}

/**
 * Normalizes every error into the frontend contract `{ code, message }` while
 * preserving the original HTTP status. SSE responses (AI advisor) are left
 * untouched — once headers are flushed we can't emit a JSON error body.
 *
 * Existing handlers that already return a richer body (e.g. the email-verify
 * redirect, or thrown exceptions carrying an explicit `code`) keep their code
 * via the `code` field when present; otherwise we derive it from the status.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // If the response has already started (e.g. an SSE stream), we can't send a
    // JSON body — just end it and let the stream's own error frame stand.
    if (res.headersSent) {
      this.logger.warn(`Exception after headers sent on ${req?.method} ${req?.url}`);
      return;
    }

    const { status, body } = this.normalize(exception);
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${req?.method} ${req?.url} -> ${status} ${body.code}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }
    res.status(status).json(body);
  }

  private normalize(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      return { status, body: this.bodyFromHttpException(status, resp) };
    }
    // Non-HTTP (unexpected) errors -> 500.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_ERROR', message: DEFAULT_MESSAGE.INTERNAL_ERROR },
    };
  }

  private bodyFromHttpException(status: number, resp: string | object): ErrorBody {
    const fallbackCode = STATUS_CODE[status] ?? 'ERROR';

    if (typeof resp === 'string') {
      return { code: fallbackCode, message: resp || DEFAULT_MESSAGE[fallbackCode] || resp };
    }

    const r = resp as Record<string, unknown>;
    // Honor an explicit machine code thrown by business logic
    // (e.g. EMAIL_NOT_VERIFIED). Nest's default `error` field carries a human
    // phrase like "Bad Request"/"Not Found", which we must NOT treat as a code —
    // only accept SCREAMING_SNAKE_CASE values as an explicit code.
    const explicitCode =
      typeof r.code === 'string' && r.code
        ? r.code
        : typeof r.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(r.error)
          ? r.error
          : null;
    const code = explicitCode ?? fallbackCode;

    // class-validator returns `message` as a string[]; collapse to the first.
    let message: string;
    if (Array.isArray(r.message)) {
      message = (r.message[0] as string) ?? DEFAULT_MESSAGE[fallbackCode] ?? 'Invalid request.';
    } else if (typeof r.message === 'string' && r.message) {
      message = r.message;
    } else {
      message = DEFAULT_MESSAGE[code] ?? DEFAULT_MESSAGE[fallbackCode] ?? 'Error';
    }

    return { code, message };
  }
}
