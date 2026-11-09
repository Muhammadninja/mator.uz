import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/** One counter a reservation has to fit under. */
export interface BudgetCounter {
  key: string;
  /** Most the counter may reach within its window. */
  limit: number;
  windowSeconds: number;
  /** Units this reservation takes from this counter. Defaults to 1. */
  cost?: number;
  /** Going over this counter opens the breaker, when the call names one. */
  tripsBreaker?: boolean;
}

export interface BudgetBreaker {
  key: string;
  /** How long a tripped breaker refuses everything. */
  cooldownSeconds: number;
}

export type BudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Key of the counter that refused, or of the breaker. */
      refusedBy: string;
      /** The breaker was already open before this call. */
      breakerOpen: boolean;
      /** This call opened the breaker. */
      breakerTripped: boolean;
      retryAfter: number;
    };

/**
 * Reserves against several counters as ONE atomic step: either every counter takes
 * its cost or none does, so a refusal by the second counter cannot leave the first
 * one charged, and however many requests arrive at once the sum never passes a limit.
 *
 * FixedWindowRateLimiter counts first and compares afterwards, which is right for a
 * limit on attempts. Money is different: a counter that has already been pushed past
 * the limit by refused requests would also misreport what was actually spent.
 *
 * Commands fail with RedisUnavailableError when Redis does not answer, and callers
 * must treat that as a refusal: a budget nobody can read is not a budget.
 */
const RESERVE_SCRIPT = `
local breaker = KEYS[1]
local cooldown = tonumber(ARGV[1])
if breaker ~= '' and redis.call('EXISTS', breaker) == 1 then
  local ttl = redis.call('TTL', breaker)
  return {0, breaker, 1, 0, ttl}
end
local n = #KEYS - 1
for i = 1, n do
  local key = KEYS[i + 1]
  local limit = tonumber(ARGV[(i - 1) * 4 + 2])
  local cost = tonumber(ARGV[(i - 1) * 4 + 4])
  local trips = ARGV[(i - 1) * 4 + 5]
  local current = tonumber(redis.call('GET', key) or '0')
  if current + cost > limit then
    local tripped = 0
    local ttl = redis.call('TTL', key)
    if breaker ~= '' and trips == '1' then
      redis.call('SET', breaker, '1', 'EX', cooldown)
      tripped = 1
      if cooldown > ttl then ttl = cooldown end
    end
    return {0, key, 0, tripped, ttl}
  end
end
for i = 1, n do
  local key = KEYS[i + 1]
  local window = tonumber(ARGV[(i - 1) * 4 + 3])
  local cost = tonumber(ARGV[(i - 1) * 4 + 4])
  local after = redis.call('INCRBY', key, cost)
  if after == cost or redis.call('TTL', key) < 0 then
    redis.call('EXPIRE', key, window)
  end
end
return {1, '', 0, 0, 0}
`;

/** Gives units back, never below zero, without creating a key that has expired. */
const RELEASE_SCRIPT = `
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  local amount = tonumber(ARGV[i])
  if current > 0 and amount > 0 then
    if amount >= current then
      redis.call('SET', KEYS[i], '0', 'KEEPTTL')
    else
      redis.call('DECRBY', KEYS[i], amount)
    end
  end
end
return 1
`;

/** Adds units that were not reserved up front, keeping the counter's window. */
const CHARGE_SCRIPT = `
for i = 1, #KEYS do
  local amount = tonumber(ARGV[(i - 1) * 2 + 1])
  local window = tonumber(ARGV[(i - 1) * 2 + 2])
  if amount > 0 then
    redis.call('INCRBY', KEYS[i], amount)
    if redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], window) end
  end
end
return 1
`;

@Injectable()
export class AtomicBudget {
  constructor(private readonly redis: RedisService) {}

  async reserve(
    counters: readonly BudgetCounter[],
    breaker?: BudgetBreaker,
  ): Promise<BudgetDecision> {
    const args: (string | number)[] = [breaker?.cooldownSeconds ?? 0];
    for (const c of counters) {
      args.push(c.limit, c.windowSeconds, c.cost ?? 1, c.tripsBreaker ? '1' : '0');
    }
    const [ok, refusedBy, breakerOpen, breakerTripped, ttl] =
      await this.redis.evalScript<[number, string, number, number, number]>(
        RESERVE_SCRIPT,
        [breaker?.key ?? '', ...counters.map((c) => c.key)],
        args,
      );
    if (ok === 1) return { allowed: true };
    return {
      allowed: false,
      refusedBy,
      breakerOpen: breakerOpen === 1,
      breakerTripped: breakerTripped === 1,
      retryAfter: Math.max(ttl, 1),
    };
  }

  /** Give back part of an earlier reservation, once its real cost is known. */
  async release(
    amounts: readonly { key: string; amount: number }[],
  ): Promise<void> {
    await this.redis.evalScript(
      RELEASE_SCRIPT,
      amounts.map((a) => a.key),
      amounts.map((a) => a.amount),
    );
  }

  /** Record spend beyond what was reserved. Never refuses: it already happened. */
  async charge(
    amounts: readonly { key: string; amount: number; windowSeconds: number }[],
  ): Promise<void> {
    await this.redis.evalScript(
      CHARGE_SCRIPT,
      amounts.map((a) => a.key),
      amounts.flatMap((a) => [a.amount, a.windowSeconds]),
    );
  }
}
