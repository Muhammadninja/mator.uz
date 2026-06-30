import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const BATCH_SIZE = 5000;
// Arbitrary app-wide constant identifying this job's Postgres advisory lock.
const ADVISORY_LOCK_KEY = 911_001;

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
      // Cross-instance guard: only the holder of the advisory lock proceeds.
      const acquired = await this.acquireLock();
      if (!acquired) {
        this.logger.log('Another instance holds the retention lock — skipping this run');
        return;
      }

      try {
        const refreshDeleted = await this.cleanupExpiredRefreshTokens();
        const verificationDeleted = await this.cleanupExpiredVerificationTokens();
        this.logger.log(
          `Retention complete in ${Date.now() - startedAt}ms — ` +
            `refresh_tokens: ${refreshDeleted} deleted, ` +
            `email_verification_tokens: ${verificationDeleted} deleted ` +
            `(retentionDays=${this.retentionDays})`,
        );
      } finally {
        await this.releaseLock();
      }
    } catch (err) {
      // Never throw out of a cron handler. Already-committed batches persist;
      // the next scheduled run resumes cleanup (retry-safe by construction).
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
  private cleanupExpiredRefreshTokens(): Promise<number> {
    const now = new Date();
    return this.batchedDelete(
      (take) =>
        this.prisma.refreshToken.findMany({
          where: { expiresAt: { lt: now } },
          select: { id: true },
          take,
        }),
      (ids) =>
        this.prisma.refreshToken
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
  private cleanupExpiredVerificationTokens(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * DAY_MS);
    return this.batchedDelete(
      (take) =>
        this.prisma.emailVerificationToken.findMany({
          where: { expiresAt: { lt: cutoff } },
          select: { id: true },
          take,
        }),
      (ids) =>
        this.prisma.emailVerificationToken
          .deleteMany({ where: { id: { in: ids } } })
          .then((r) => r.count),
    );
  }

  /**
   * Delete in bounded batches so each statement is a short, index-friendly
   * transaction that never holds a long lock. Each batch commits independently,
   * so a crash mid-run leaves a safe partial result that the next run finishes.
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

  // Postgres session-level advisory lock. NOTE: with a connection pool the
  // unlock should land on the same backend; we treat the lock as best-effort
  // mutual exclusion. The real safety net is idempotency — concurrent runs can
  // only race to delete the same dead rows, which is harmless. For strict
  // single execution, run the scheduler on one instance.
  private async acquireLock(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked
    `;
    return rows[0]?.locked === true;
  }

  private async releaseLock(): Promise<void> {
    await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}
