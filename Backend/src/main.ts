import { NestFactory } from '@nestjs/core';
import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';
import {
  createSwaggerAuthMiddleware,
  resolveSwaggerCredentials,
} from './common/swagger-auth.middleware';
import {
  PAYME_WEBHOOK_PATH,
  paymeRawBodyMiddleware,
} from './orders/webhooks/payme-raw-body.middleware';

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

/**
 * Last-resort safety net. An uncaught exception or unhandled rejection means
 * the process is in an unknown state — Node will otherwise either crash
 * silently (no log) or, for unhandledRejection, just print a warning and keep
 * running in that unknown state. Log it through Nest's Logger (consistent
 * with the rest of the app, PM2-captured) and exit non-zero so PM2 restarts
 * us cleanly rather than limping on.
 */
function installProcessErrorHandlers(
  getApp: () => import('@nestjs/common').INestApplication | undefined,
) {
  const logger = new Logger('Process');

  const fatal = (label: string, err: unknown) => {
    logger.error(
      `${label}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
    const app = getApp();
    // Best-effort graceful close (runs OnModuleDestroy, e.g. stopping the
    // Telegram bot) before exiting; don't let a hung close() block the exit.
    const exit = () => process.exit(1);
    if (app) {
      void app.close().finally(exit);
      setTimeout(exit, 5000).unref();
    } else {
      exit();
    }
  };

  process.on('uncaughtException', (err) => fatal('Uncaught exception', err));
  process.on('unhandledRejection', (reason) =>
    fatal('Unhandled rejection', reason),
  );
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  let app: import('@nestjs/common').INestApplication | undefined;
  installProcessErrorHandlers(() => app);

  app = await NestFactory.create(AppModule);

  // Run OnModuleDestroy/OnApplicationShutdown hooks on SIGTERM/SIGINT (PM2
  // restart/redeploy, systemd stop, ctrl-C) — e.g. TelegramService.onModuleDestroy
  // stopping the long-polling bot cleanly instead of leaving it dangling.
  app.enableShutdownHooks();

  // Trust the first hop (Nginx) so req.ip reflects the real client IP instead
  // of the proxy's — required for per-IP throttling (@nestjs/throttler) to key
  // on individual clients rather than bucketing everyone behind Nginx together.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Correlation id, FIRST in the chain so every subsequent log line — including
  // ones emitted by rejected requests — can carry it. Echoed back as
  // X-Request-Id and readable anywhere downstream via getRequestId().
  app.use(requestIdMiddleware);

  // Payme requires HTTP 200 with a JSON-RPC error even for an unparseable body
  // (-32700), but the global JSON parser answers a syntax error with HTTP 400 —
  // which Payme reads as -32400. Capture the Payme webhook body as raw text
  // BEFORE that parser sees it; PaymeService parses it and reports -32700
  // itself. Scoped to the single Payme route, so every other endpoint keeps the
  // standard parsing and validation.
  app.use(PAYME_WEBHOOK_PATH, paymeRawBodyMiddleware);

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
    logger.warn(
      'CORS_ORIGINS is empty in production — all browser origins will be rejected.',
    );
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Normalize all errors to the frontend `{ code, message }` contract.
  app.useGlobalFilters(new HttpExceptionFilter());
  // Native `ws` adapter powers the /realtime gateway (raw WebSocket protocol).
  app.useWebSocketAdapter(new WsAdapter(app));

  // OpenAPI / Swagger docs at /docs. Read-only: it introspects the existing
  // routes and DTOs (metadata auto-generated by the @nestjs/swagger CLI plugin)
  // and changes no runtime behavior. The 'jwt' bearer scheme is referenced by
  // @ApiBearerAuth('jwt') on the JWT-protected controllers/handlers.
  //
  // Exposed everywhere EXCEPT production, where it is off by default so the full
  // route/DTO map isn't published to the internet. Enable it in production with
  // ENABLE_SWAGGER=true — and when it IS enabled there, /docs is served only
  // behind HTTP Basic Auth (SWAGGER_USERNAME / SWAGGER_PASSWORD), exactly like
  // the Bull Board dashboard. When ENABLE_SWAGGER is not 'true' in production
  // the routes are never registered at all, so /docs and /docs-json 404.
  const swaggerEnabled = !isProd || process.env.ENABLE_SWAGGER === 'true';
  if (swaggerEnabled) {
    // Basic Auth guards the docs in production only: in development the whole
    // point is a frictionless local /docs, and nothing is exposed publicly.
    // Registered BEFORE SwaggerModule.setup so it runs first on /docs*, and it
    // fails closed — unset credentials deny every request rather than publish.
    if (isProd) {
      const credentials = resolveSwaggerCredentials();
      if (!credentials.user || !credentials.password) {
        logger.warn(
          'ENABLE_SWAGGER=true but SWAGGER_USERNAME/SWAGGER_PASSWORD are unset — ' +
            '/docs will refuse every request until they are configured.',
        );
      }
      const express = app.getHttpAdapter().getInstance() as {
        use: (path: string[], handler: RequestHandler) => unknown;
      };
      express.use(
        ['/docs', '/docs-json', '/docs-yaml'],
        createSwaggerAuthMiddleware(credentials, logger),
      );
    }

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Mator API')
      .setDescription('REST API Documentation')
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'jwt',
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
    logger.log(
      isProd
        ? 'Swagger docs enabled at /docs (HTTP Basic Auth required).'
        : 'Swagger docs enabled at /docs.',
    );
  } else {
    logger.log(
      'Swagger docs disabled in production (set ENABLE_SWAGGER=true to enable).',
    );
  }

  // Fire OnModuleDestroy on SIGTERM/SIGINT so the Telegram bot stops its long
  // poll cleanly on restart (otherwise the next instance gets a 409 Conflict).
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
  logger.log(`Mator backend listening on port ${process.env.PORT ?? 3000}`);
}
bootstrap();
