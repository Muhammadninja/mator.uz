import { NestFactory } from '@nestjs/core';
import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

/**
 * Parse a comma-separated CORS allowlist from CORS_ORIGINS. In production an
 * empty list means "deny all browser origins" (server-to-server and the mobile
 * app are unaffected, since they don't send an Origin the browser enforces).
 */
function parseCorsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Security headers. The API serves JSON (and SSE for the AI advisor), so the
  // restrictive CSP defaults don't apply; disable CSP to avoid breaking the
  // mobile client and keep the other protections (HSTS, noSniff, etc.).
  app.use(helmet({ contentSecurityPolicy: false }));

  const allowlist = parseCorsOrigins();
  const isProd = process.env.NODE_ENV === 'production';
  app.enableCors({
    // Reflect only allowlisted origins. Requests without an Origin header
    // (native mobile app, server-to-server, curl) are always allowed.
    origin: (origin, callback) => {
      if (!origin || allowlist.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  if (isProd && allowlist.length === 0) {
    logger.warn('CORS_ORIGINS is empty in production — all browser origins will be rejected.');
  }

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  // Normalize all errors to the frontend `{ code, message }` contract.
  app.useGlobalFilters(new HttpExceptionFilter());
  // Native `ws` adapter powers the /realtime gateway (raw WebSocket protocol).
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
  logger.log(`Mator backend listening on port ${process.env.PORT ?? 3000}`);
}
bootstrap();
