export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const REDIS_STARTUP_TIMEOUT_MS = 10_000;

/** Longest a request waits on one Redis command before it is refused. */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

export const REDIS_CONNECT_TIMEOUT_MS = 5_000;

/** How long shutdown waits for a clean QUIT before dropping the socket. */
export const REDIS_QUIT_TIMEOUT_MS = 2_000;
