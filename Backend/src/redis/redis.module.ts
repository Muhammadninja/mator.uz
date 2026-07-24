import { Global, Module } from '@nestjs/common';
import { redisProvider } from './redis.provider';
import { RedisService } from './redis.service';
import { CacheService } from './cache.service';
import { FixedWindowRateLimiter, RATE_LIMITER } from './rate-limiter.service';

// Bind the algorithm-agnostic RATE_LIMITER token to the fixed-window
// implementation. Consumers inject the token (typed as RateLimiter), so
// swapping the algorithm later is a change here only — never at any call site.
const rateLimiterProvider = {
  provide: RATE_LIMITER,
  useClass: FixedWindowRateLimiter,
};

@Global()
@Module({
  providers: [redisProvider, RedisService, CacheService, rateLimiterProvider],
  exports: [RedisService, CacheService, RATE_LIMITER],
})
export class RedisModule {}
