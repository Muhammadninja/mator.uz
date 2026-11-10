import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const BATCH_SIZE = 5000;
// Arbitrary app-wide constant identifying this job's Postgres advisory lock.
const ADVISORY_LOCK_KEY = 911_001;
// How long one run may take. Past it the transaction rolls back, releasing the lock,
// and the next run starts again: it only ever deletes dead rows.
const LOCK_HOLD_TIMEOUT_MS = 30 * 60 * 1000;

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private readonly retentionDays: number;
  // In-process reentrancy guard: prevents a new run starting while a previous
  // one (unexpectedly long) is still executing on THIS instance.
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const parsed = Number.parseInt(config.get<string>('RETENTION_DAYS') ?? '', 10);
    this.retentionDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  }

  /**
   * Daily at 03:00 UTC (off-peak). Deletion is idempotent and only ever
   * targets dead rows, so a missed/retried run is harmless.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'token-retention', timeZone: 'UTC' })
  async handleRetention(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Retention run already in progress on this instance — skipping');
      return;
    }
    this.isRunning = true;
    const startedAt = Date.now();

    try {
      // Cross-instance guard. The lock and the deletes share this one transaction, so
      // they share one server connection, also under PgBouncer's transaction pooling,
      // and need only one from the pool. Postgres releases the lock when the
      // transaction ends, however that comes about, including a crash.
      await this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked
          `;
          if (rows[0]?.locked !== true) {
            this.logger.log('Another instance holds the retention lock — skipping this run');
            return;
          }
          const refreshDeleted = await this.cleanupExpiredRefreshTokens(tx);
          const verificationDeleted = await this.cleanupExpiredVerificationTokens(tx);
          this.logger.log(
            `Retention complete in ${Date.now() - startedAt}ms — ` +
              `refresh_tokens: ${refreshDeleted} deleted, ` +
              `email_verification_tokens: ${verificationDeleted} deleted ` +
              `(retentionDays=${this.retentionDays})`,
          );
        },
        { maxWait: 10_000, timeout: LOCK_HOLD_TIMEOUT_MS },
      );
    } catch (err) {
      // Never throw out of a cron handler. The next scheduled run does the cleanup
      // (retry-safe by construction).
      this.logger.error(
        `Retention run failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Refresh tokens: delete only those already past expiry. Active sessions
   * have expiresAt > now and are never matched. Index-backed by
   * refresh_tokens(expires_at).
   */
  private cleanupExpiredRefreshTokens(tx: Prisma.TransactionClient): Promise<number> {
    const now = new Date();
    return this.batchedDelete(
      (take) =>
        tx.refreshToken.findMany({
          where: { expiresAt: { lt: now } },
          select: { id: true },
          take,
        }),
      (ids) =>
        tx.refreshToken
          .deleteMany({ where: { id: { in: ids } } })
          .then((r) => r.count),
    );
  }

  /**
   * Email verification tokens: keep ACTIVE tokens (expiresAt >= now) forever,
   * and keep consumed/expired tokens for `retentionDays` of audit history.
   * A token is removed once it expired more than `retentionDays` ago.
   *
   * Filtering on expiresAt (rather than createdAt) keeps this index-backed by
   * email_verification_tokens(expires_at); since the TTL is 24h, "expired >
   * retentionDays ago" is equivalent to "older than the retention window".
   * Active tokens (expiresAt >= now) can never match a past cutoff, so they
   * are structurally safe from deletion.
   */
  private cleanupExpiredVerificationTokens(tx: Prisma.TransactionClient): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * DAY_MS);
    return this.batchedDelete(
      (take) =>
        tx.emailVerificationToken.findMany({
          where: { expiresAt: { lt: cutoff } },
          select: { id: true },
          take,
        }),
      (ids) =>
        tx.emailVerificationToken
          .deleteMany({ where: { id: { in: ids } } })
          .then((r) => r.count),
    );
  }

  /**
   * Delete in bounded batches so each statement stays short and index-friendly.
   */
  private async batchedDelete(
    findIds: (take: number) => Promise<{ id: number }[]>,
    removeIds: (ids: number[]) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await findIds(BATCH_SIZE);
      if (rows.length === 0) break;
      total += await removeIds(rows.map((r) => r.id));
      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }
}
