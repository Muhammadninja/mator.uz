import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { RedisKeys } from '../../redis/redis.keys';
import { RedisService } from '../../redis/redis.service';
import type { Request } from 'express';
import { adminClientAddress, type AdminClientAddress } from './admin-client-ip';

/** Failures before a lock starts, per account and per account-and-address pair. */
export const ADMIN_LOGIN_ACCOUNT_THRESHOLD = 5;
/** One address guessing across many accounts. */
export const ADMIN_LOGIN_IP_THRESHOLD = 20;
export const ADMIN_LOGIN_BASE_LOCK_S = 30;
export const ADMIN_LOGIN_MAX_LOCK_S = 15 * 60;
/**
 * Tries an address gets at an account while the account lock runs, if it has not
 * failed there before. A pair of tries, so a stream of addresses gains little.
 */
export const ADMIN_LOGIN_FRESH_ADDRESS_TRIES = 2;
/** A signed panel request is accepted within a minute either way of its timestamp. */
const PANEL_PROOF_MEMORY_S = 120;
/** Failures are forgotten this long after the last one. */
const FAILURE_MEMORY_S = 60 * 60;
/** How long an address stays known for an account after a successful sign-in. */
const TRUSTED_ADDRESS_S = 30 * 24 * 60 * 60;

/**
 * Keys: 1 account fails, 2 account lock, 3 pair fails, 4 pair lock, 5 ip fails,
 * 6 ip lock, 7 trusted marker. Returns {scope, seconds}; scope '' means proceed.
 *
 * The lock doubles with each further failure and is capped, and an attempt is let
 * through whenever the lock has lapsed, so an account always recovers on its own.
 * A refused attempt counts nothing and cannot lengthen a lock.
 */
const BEGIN_SCRIPT = `
local distinct = ARGV[1] == '1'
local accountThreshold = tonumber(ARGV[2])
local ipThreshold = tonumber(ARGV[3])
local base = tonumber(ARGV[4])
local cap = tonumber(ARGV[5])
local memory = tonumber(ARGV[6])
local freshTries = tonumber(ARGV[7])
local function seconds(key)
  local ttl = redis.call('TTL', key)
  if ttl > 0 then return ttl end
  return 0
end
if distinct then
  local t = seconds(KEYS[4])
  if t > 0 then return {'pair', t} end
  t = seconds(KEYS[6])
  if t > 0 then return {'ip', t} end
end
local trusted = distinct and redis.call('EXISTS', KEYS[7]) == 1
local fresh = distinct and tonumber(redis.call('GET', KEYS[3]) or '0') < freshTries
if not trusted and not fresh then
  local t = seconds(KEYS[2])
  if t > 0 then return {'account', t} end
end
local function count(fails, lock, threshold)
  local n = redis.call('INCR', fails)
  redis.call('EXPIRE', fails, memory)
  if n >= threshold then
    local delay = math.floor(base * (2 ^ math.min(n - threshold, 20)))
    if delay > cap then delay = cap end
    redis.call('SET', lock, '1', 'EX', delay)
  end
end
count(KEYS[1], KEYS[2], accountThreshold)
if distinct then
  count(KEYS[3], KEYS[4], accountThreshold)
  count(KEYS[5], KEYS[6], ipThreshold)
end
return {'', 0}
`;

/** This attempt was a correct password: take back only its own count. */
const FORGIVE_ATTEMPT_SCRIPT = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then
  redis.call('DECR', KEYS[1])
end
return 1
`;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Failed-login tracking for administrators, kept in Redis so it holds across restarts
 * and however the request arrived. Three separate controls:
 *
 *  - per account, however many addresses the guesses come from;
 *  - per account and address, so one source is stopped without affecting others;
 *  - per address, for one source trying many accounts.
 *
 * An attacker who knows an administrator's email can keep the account lock running
 * from a stream of addresses. So the ACCOUNT lock exempts an address that has signed
 * in to this account successfully, and gives any other address that has not failed
 * there a couple of tries: the operator can still get in during an attack, even from
 * a new device. A wrong password from such an address still hits its own pair lock.
 *
 * Without ADMIN_PROXY_SECRET addresses identify nobody, so none of that applies; the
 * account lock stands alone and still lapses within ADMIN_LOGIN_MAX_LOCK_S.
 *
 * Refusals are the same for known and unknown emails. Redis errors propagate as a
 * 503, so an outage refuses sign-in rather than removing the limit.
 */
@Injectable()
export class AdminLoginProtection {
  private readonly logger = new Logger(AdminLoginProtection.name);

  constructor(private readonly redis: RedisService) {}

  private keys(email: string, client: AdminClientAddress) {
    const account = digest(email.trim().toLowerCase());
    const ip = digest(client.ip);
    const pair = digest(`${account}:${ip}`);
    return { account, ip, pair };
  }

  /**
   * This request's address. A panel signature counts once: a copy, resent inside its
   * minute, is treated like any unsigned caller and counted by its own address.
   */
  async resolveClient(req: Request): Promise<AdminClientAddress> {
    const client = adminClientAddress(req);
    if (!client.proof) return client;
    const first = await this.redis.setNxEx(
      RedisKeys.adminPanelProof(digest(client.proof)),
      PANEL_PROOF_MEMORY_S,
      '1',
    );
    if (first) return client;
    this.logger.warn('Replayed panel signature ignored');
    return { ip: req.ip ?? 'unknown', distinct: client.distinct };
  }

  /** Count this attempt, or throw 429 when a lock is in force. */
  async beginAttempt(email: string, client: AdminClientAddress): Promise<void> {
    const { account, ip, pair } = this.keys(email, client);
    const [scope, seconds] = await this.redis.evalScript<[string, number]>(
      BEGIN_SCRIPT,
      [
        RedisKeys.adminLoginAccountFails(account),
        RedisKeys.adminLoginAccountLock(account),
        RedisKeys.adminLoginPairFails(pair),
        RedisKeys.adminLoginPairLock(pair),
        RedisKeys.adminLoginIpFails(ip),
        RedisKeys.adminLoginIpLock(ip),
        RedisKeys.adminLoginTrusted(pair),
      ],
      [
        client.distinct ? '1' : '0',
        ADMIN_LOGIN_ACCOUNT_THRESHOLD,
        ADMIN_LOGIN_IP_THRESHOLD,
        ADMIN_LOGIN_BASE_LOCK_S,
        ADMIN_LOGIN_MAX_LOCK_S,
        FAILURE_MEMORY_S,
        ADMIN_LOGIN_FRESH_ADDRESS_TRIES,
      ],
    );
    if (!scope) return;
    this.logger.warn(`Admin login refused by ${scope} lock for ${seconds}s`);
    throw new HttpException(
      {
        code: 'ADMIN_LOGIN_LOCKED',
        message: 'Too many failed sign-in attempts. Please try again later.',
        details: { retry_after_seconds: seconds },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Clear this account's failures and remember the address. The per-address counter
   * only loses this attempt: a valid login must not wipe guesses at other accounts,
   * and an office signing in all day must not lock itself out. Best effort, because
   * the password has already been proven.
   */
  async recordSuccess(email: string, client: AdminClientAddress): Promise<void> {
    const { account, ip, pair } = this.keys(email, client);
    try {
      await Promise.all([
        this.redis.del(RedisKeys.adminLoginAccountFails(account)),
        this.redis.del(RedisKeys.adminLoginAccountLock(account)),
        this.redis.del(RedisKeys.adminLoginPairFails(pair)),
        this.redis.del(RedisKeys.adminLoginPairLock(pair)),
        client.distinct
          ? this.redis.setEx(
              RedisKeys.adminLoginTrusted(pair),
              TRUSTED_ADDRESS_S,
              true,
            )
          : Promise.resolve(),
        client.distinct
          ? this.redis.evalScript(
              FORGIVE_ATTEMPT_SCRIPT,
              [RedisKeys.adminLoginIpFails(ip)],
              [],
            )
          : Promise.resolve(),
      ]);
    } catch (err) {
      this.logger.warn(
        `Could not clear admin login failures: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
