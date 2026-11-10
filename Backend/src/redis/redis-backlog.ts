import { Logger } from '@nestjs/common';

/**
 * A hard cap on Redis commands this process has stopped waiting for.
 *
 * withRedisTimeout gives up WAITING on a command, but cannot cancel it: ioredis
 * keeps it until it is answered or flushed, and on BullMQ's connections
 * (`maxRetriesPerRequest: null`, queue.config.ts) an add() stays parked until
 * the connection is ready. Each such command holds its
 * arguments (a job payload, a key) in memory. Before the bounds, a stuck caller
 * also stopped producing new commands (a bot handler held up the whole batch);
 * a bounded caller does not, so during a long outage the unanswered commands
 * would only grow. This counts them, and once MAX are outstanding, a new
 * command is refused BEFORE it is issued (RedisBacklogError): memory stays
 * bounded, and the caller takes its existing "Redis unavailable" path.
 *
 * Counted: every command a withRedisTimeout gave up on, and every command
 * issued without a waiter (trackUnansweredRedisCommand). A command that is
 * still awaited is not counted — its caller is holding it, as before.
 *
 * Process-wide on purpose: the offline queue it protects is process memory, and
 * the counter must cover the shared client and BullMQ's connections alike.
 */

/** Measured ~2 KB per parked BullMQ add (notification-sized payload):
 *  under 1 MB at the cap. */
export const MAX_UNANSWERED_REDIS_COMMANDS = 500;

const logger = new Logger('RedisBacklog');
let unanswered = 0;
let saturated = false;

/** Commands given up on (or issued unawaited) that Redis has not answered yet. */
export function unansweredRedisCommands(): number {
  return unanswered;
}

/** Redis did not answer in time, or too many commands are still unanswered. */
export class RedisUnavailableError extends Error {}

/** A command bounded by withRedisTimeout got no answer in time. It may still
 *  complete later — see withRedisTimeout. */
export class RedisTimeoutError extends RedisUnavailableError {
  constructor(what: string, ms: number) {
    super(`Redis ${what} timed out after ${ms}ms`);
    this.name = 'RedisTimeoutError';
  }
}

/** The command was NOT issued: too many earlier ones are still unanswered. */
export class RedisBacklogError extends RedisUnavailableError {
  constructor(what: string, count: number) {
    super(
      `Redis ${what} not sent: ${count} earlier commands are still unanswered`,
    );
    this.name = 'RedisBacklogError';
  }
}

/** Throw RedisBacklogError instead of issuing one more command at the cap. */
export function assertRedisBacklogRoom(what: string): void {
  if (unanswered < MAX_UNANSWERED_REDIS_COMMANDS) return;
  if (!saturated) {
    saturated = true;
    logger.error(
      `${unanswered} Redis commands are unanswered — refusing new ones until ` +
        'Redis answers (callers fall back to their "Redis unavailable" path)',
    );
  }
  throw new RedisBacklogError(what, unanswered);
}

/** Count `command` as unanswered until it settles. */
export function trackUnansweredRedisCommand(command: Promise<unknown>): void {
  unanswered += 1;
  const settled = () => {
    unanswered -= 1;
    if (saturated && unanswered < MAX_UNANSWERED_REDIS_COMMANDS / 2) {
      saturated = false;
      logger.log(
        `Redis answers again — ${unanswered} commands still unanswered`,
      );
    }
  };
  command.then(settled, settled);
}
