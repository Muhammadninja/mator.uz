/**
 * Failed-job retention policy.
 *
 * DEFAULT_JOB_OPTIONS reads process.env at MODULE LOAD time (it is a plain
 * const, evaluated on import), so each case sets the env and re-imports the
 * module inside `jest.isolateModules` to get a freshly evaluated object.
 */

type JobOptions = typeof import('./queue.constants').DEFAULT_JOB_OPTIONS;

/** Load DEFAULT_JOB_OPTIONS with the given env applied. */
function loadWithEnv(env: Record<string, string | undefined>): JobOptions {
  const original = { ...process.env };
  Object.assign(process.env, env);
  let options!: JobOptions;
  try {
    jest.isolateModules(() => {
      // `require` (not import) is required here: isolateModules takes a
      // SYNCHRONOUS callback, and the module must be re-evaluated inside it so
      // DEFAULT_JOB_OPTIONS picks up the env set just above.
      /* eslint-disable @typescript-eslint/no-require-imports */
      const reloaded =
        require('./queue.constants') as typeof import('./queue.constants');
      /* eslint-enable @typescript-eslint/no-require-imports */
      options = reloaded.DEFAULT_JOB_OPTIONS;
    });
  } finally {
    process.env = original;
  }
  return options;
}

const DAY_SECONDS = 24 * 60 * 60;

describe('failed job retention', () => {
  it('retains failures for 7 days and 5 000 jobs by default', () => {
    const options = loadWithEnv({
      QUEUE_FAILED_RETENTION_DAYS: undefined,
      QUEUE_FAILED_RETENTION_COUNT: undefined,
    });

    expect(options.removeOnFail).toEqual({
      age: 7 * DAY_SECONDS,
      count: 5_000,
    });
  });

  it('never removes failed jobs immediately', () => {
    const options = loadWithEnv({});

    // The regression this guards: `removeOnFail: true` (or 0) would discard the
    // exact jobs an operator needs to debug an incident.
    expect(options.removeOnFail).not.toBe(true);
    expect(options.removeOnFail).not.toBe(0);
    const { age, count } = options.removeOnFail as {
      age: number;
      count: number;
    };
    expect(age).toBeGreaterThanOrEqual(DAY_SECONDS);
    expect(count).toBeGreaterThan(0);
  });

  it('keeps retention bounded on both age and count', () => {
    const options = loadWithEnv({});
    const removeOnFail = options.removeOnFail as {
      age?: number;
      count?: number;
    };

    // Unbounded retention would grow Redis without limit — both caps must exist.
    expect(removeOnFail.age).toBeDefined();
    expect(removeOnFail.count).toBeDefined();
  });

  it('honours env overrides', () => {
    const options = loadWithEnv({
      QUEUE_FAILED_RETENTION_DAYS: '14',
      QUEUE_FAILED_RETENTION_COUNT: '10000',
    });

    expect(options.removeOnFail).toEqual({
      age: 14 * DAY_SECONDS,
      count: 10_000,
    });
  });

  it('falls back to the default for a zero or invalid override', () => {
    const options = loadWithEnv({
      QUEUE_FAILED_RETENTION_DAYS: '0',
      QUEUE_FAILED_RETENTION_COUNT: 'lots',
    });

    // "0 days" must not be read as "delete immediately".
    expect(options.removeOnFail).toEqual({
      age: 7 * DAY_SECONDS,
      count: 5_000,
    });
  });

  it('leaves retry behaviour untouched', () => {
    const options = loadWithEnv({});

    // Retention changes must never alter retry semantics.
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 2_000 });
  });
});
