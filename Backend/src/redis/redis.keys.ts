export const RedisKeys = {
  otp: (phone: string): string => `otp:${phone}`,
  // Reverse pointer requestId -> phone, so the request_id-based resend/verify
  // API paths can resolve back to the phone-keyed OTP record above without
  // changing their public signatures.
  otpRequest: (requestId: string): string => `otp:req:${requestId}`,
  jwtBlacklist: (jti: string): string => `jwt:blacklist:${jti}`,

  // ── Cache (read-through, TTL-only invalidation) ───────────────────────────
  // Reference catalog lists cached via CacheService. Keyed by the parameter the
  // list depends on, so each cached payload is exactly one endpoint response.
  // Engines carry no per-parameter variation (trimId validates existence only,
  // the full list is always returned), so they use a single key. Add a builder
  // here per cached resource rather than formatting keys at the call site.
  cacheReferenceMakes: (): string => `cache:reference:makes`,
  cacheReferenceModels: (makeId: string): string => `cache:reference:models:${makeId}`,
  cacheReferenceTrims: (modelId: string): string => `cache:reference:trims:${modelId}`,
  cacheReferenceEngines: (): string => `cache:reference:engines`,

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Fixed-window counters consumed via the RateLimiter (FixedWindow). One key per
  // (action, subject) pair; INCR bumps it, EXPIRE arms the window on the first
  // hit. Keep the `rate:<action>:<subject>` shape so keyspaces never collide
  // and every limiter is greppable. Add a new builder here per action rather
  // than formatting keys at the call site.
  rateOtpRequest: (phone: string): string => `rate:otp:request:${phone}`,
  rateOtpVerify: (phone: string): string => `rate:otp:verify:${phone}`,
  rateLogin: (ip: string): string => `rate:login:${ip}`,
  rateRefresh: (userId: string): string => `rate:refresh:${userId}`,
  rateSms: (phone: string): string => `rate:sms:${phone}`,
} as const;
