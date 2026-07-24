export const RedisKeys = {
  otp: (phone: string): string => `otp:${phone}`,
  jwtBlacklist: (jti: string): string => `jwt:blacklist:${jti}`,
  cacheReference: (resource: string): string => `cache:reference:${resource}`,
} as const;
