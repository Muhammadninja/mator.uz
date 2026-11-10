export const RedisKeys = {
  otp: (phone: string): string => `otp:${phone}`,
  // Reverse pointer requestId -> phone, so the request_id-based resend/verify
  // API paths can resolve back to the phone-keyed OTP record above without
  // changing their public signatures.
  otpRequest: (requestId: string): string => `otp:req:${requestId}`,
  // Codes compared so far for one request_id, counted by the RateLimiter. Its own
  // key because the record above is a JSON value that cannot be incremented.
  otpAttempts: (requestId: string): string => `otp:attempts:${requestId}`,
  // The one phone change in progress for an account; see PhoneChangeService.
  phoneChange: (userId: string): string => `otp:phone_change:${userId}`,
  // An OTP waiting for its SMS worker, encrypted; see OtpJobSecretStore.
  otpSmsSecret: (ref: string): string => `otp:sms:${ref}`,
  jwtBlacklist: (jti: string): string => `jwt:blacklist:${jti}`,
  // Admin access-token revocation; see AdminTokenService. Separate from the buyer
  // blacklist so neither identity space can revoke the other's tokens.
  adminJwtBlacklist: (jti: string): string => `admin:jwt:blacklist:${jti}`,
  // The stable id of the device session a refresh row belongs to.
  adminSessionOfRow: (rowId: number): string => `admin:session:row:${rowId}`,
  // A device session that was signed out; kills its access tokens.
  adminSessionRevoked: (sid: string): string => `admin:session:revoked:${sid}`,

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
  // calls invalidate(), which deletes these keys.
  cacheReferenceCategories: (): string => `cache:reference:categories`,
  cacheReferenceCategoryChildren: (parentId: string): string =>
    `cache:reference:categories:children:${parentId}`,
  // Listed parts per root, merged into the roots response — never into the
  // roots payload the bot shares. A short TTL is what carries new listings
  // into it; invalidate() drops it too, since a taxonomy edit re-roots parts.
  cacheReferenceCategoryCounts: (): string =>
    `cache:reference:categories:counts`,
  // A road distance between two points. `routeId` is a hash, so no buyer location
  // sits in the keyspace: see DeliveryQuoteService.
  cacheDeliveryRoute: (routeId: string): string =>
    `cache:delivery:route:${routeId}`,
  // What a typed address found. Hashed like the route, so what people type is not in the
  // keyspace: see AddressSuggestionsService.
  cacheAddressSearch: (searchId: string): string =>
    `cache:address:search:${searchId}`,
  // What is at a point on the map. Hashed for the same reason.
  cacheAddressReverse: (pointId: string): string =>
    `cache:address:reverse:${pointId}`,

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Fixed-window counters consumed via the RateLimiter (FixedWindow). One key per
  // (action, subject) pair; INCR bumps it, EXPIRE arms the window on the first
  // hit. Keep the `rate:<action>:<subject>` shape so keyspaces never collide
  // and every limiter is greppable. Add a new builder here per action rather
  // than formatting keys at the call site.
  // One OTP SMS per phone per minute; holds the claim of the request that sent it.
  otpSendCooldown: (phone: string): string => `otp:cooldown:${phone}`,
  rateOtpVerify: (phone: string): string => `rate:otp:verify:${phone}`,
  // Delivery quotes and paid routing calls, per buyer (see RoutingBudgetService).
  rateDeliveryQuote: (userId: string): string => `rate:delivery:quote:${userId}`,
  budgetRoutingDay: (userId: string): string => `budget:routing:day:${userId}`,
  // Admin sign-in failures (see AdminLoginProtection). Hashed, so no email or
  // address sits in the keyspace.
  adminLoginAccountFails: (account: string): string =>
    `rate:admin:login:acct:${account}`,
  adminLoginAccountLock: (account: string): string =>
    `lock:admin:login:acct:${account}`,
  adminLoginPairFails: (pair: string): string =>
    `rate:admin:login:pair:${pair}`,
  adminLoginPairLock: (pair: string): string =>
    `lock:admin:login:pair:${pair}`,
  adminLoginIpFails: (ip: string): string => `rate:admin:login:ip:${ip}`,
  adminLoginIpLock: (ip: string): string => `lock:admin:login:ip:${ip}`,
  adminLoginTrusted: (pair: string): string =>
    `admin:login:trusted:${pair}`,
  // A panel signature already used; each one is good for a single request.
  adminPanelProof: (proof: string): string => `admin:panel:proof:${proof}`,
  // Wrong passwords on a Basic Auth page, per client; see BasicAuthThrottle.
  rateBasicAuth: (scope: string, client: string): string =>
    `rate:basic-auth:${scope}:${client}`,
  rateLogin: (ip: string): string => `rate:login:${ip}`,
  rateRefresh: (userId: string): string => `rate:refresh:${userId}`,
  rateSms: (phone: string): string => `rate:sms:${phone}`,
  // AI advisor messages, keyed on the USER rather than the session: the budget
  // being enforced is model spend, so opening a second session must not grant a
  // second allowance.
  rateAiMessage: (userId: string): string => `rate:ai:message:${userId}`,
  // Driver's Village photo updates (see DvPhotoLimits).
  rateDvAlbum: (tgUserId: number): string => `rate:dv:album:${tgUserId}`,
  rateDvAmbiguous: (tgUserId: number): string =>
    `rate:dv:ambiguous:${tgUserId}`,
  // An album waiting for its sender to confirm, before any FLUX job exists.
  dvPhotoPending: (token: string): string => `dv:photo:pending:${token}`,

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
