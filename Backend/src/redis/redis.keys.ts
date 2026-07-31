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
  cacheReferenceModels: (makeId: string): string =>
    `cache:reference:models:${makeId}`,
  cacheReferenceTrims: (modelId: string): string =>
    `cache:reference:trims:${modelId}`,
  cacheReferenceEngines: (): string => `cache:reference:engines`,
  // Dynamic part-category tree served to the seller bot. Unlike the vehicle
  // reference lists above (TTL-only), these ARE explicitly busted: the admin
  // console edits this taxonomy at runtime and the bot must not offer a category
  // that was just renamed or deactivated. Every write in PartCategoryService
  // calls invalidate(), which deletes both keys.
  cacheReferenceCategories: (): string => `cache:reference:categories`,
  cacheReferenceCategoryChildren: (parentId: string): string =>
    `cache:reference:categories:children:${parentId}`,

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

  // ── Draft-flow locks (DraftLock) ──────────────────────────────────────────
  // Short-lived mutexes that collapse duplicate taps on the draft/preview flow
  // BEFORE the redundant work runs. They are an optimisation only: every guarded
  // operation is independently enforced in PostgreSQL (versioned transitions,
  // the previewSentAt compare-and-set, deterministic BullMQ job ids), so losing
  // a lock means "a duplicate — skip", never "this succeeded". Scoped per draft
  // so two sellers, or two different drafts, never contend.
  lockDraftClone: (draftId: string): string => `lock:draft:clone:${draftId}`,
  lockDraftPreview: (draftId: string): string =>
    `lock:draft:preview:${draftId}`,
  lockDraftReopen: (draftId: string): string => `lock:draft:reopen:${draftId}`,
  // Keyed by the image ROW, matching the deterministic jobId's granularity: two
  // enqueues of the same row collapse, two different rows never block each other.
  lockDraftImageEnqueue: (draftId: string, imageId: string): string =>
    `lock:draft:image:${draftId}:${imageId}`,
} as const;
