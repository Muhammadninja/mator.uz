// Test stub for the ESM-only `jose` package. The social verifiers are always
// mocked in smoke tests, so these are never actually invoked.
export const createRemoteJWKSet = () => () => ({});
export const jwtVerify = async () => ({ payload: {}, protectedHeader: {} });
export type JWTPayload = Record<string, unknown>;
