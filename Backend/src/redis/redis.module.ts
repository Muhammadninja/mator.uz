import { Global, Module } from '@nestjs/common';
import { redisProvider } from './redis.provider';
import { RedisService } from './redis.service';
import { CacheService } from './cache.service';
import { DraftLock } from './draft-lock.service';
import { FixedWindowRateLimiter, RATE_LIMITER } from './rate-limiter.service';
import { AtomicBudget } from './atomic-budget.service';

// Bind the algorithm-agnostic RATE_LIMITER token to the fixed-window
// implementation. Consumers inject the token (typed as RateLimiter), so
// swapping the algorithm later is a change here only — never at any call site.
const rateLimiterProvider = {
  provide: RATE_LIMITER,
  useClass: FixedWindowRateLimiter,
};

@Global()
@Module({
  providers: [
    redisProvider,
    RedisService,
    CacheService,
    DraftLock,
    rateLimiterProvider,
    AtomicBudget,
  ],
  exports: [RedisService, CacheService, DraftLock, RATE_LIMITER, AtomicBudget],
})
export class RedisModule {}
