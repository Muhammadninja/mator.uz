/** The subset of a BullMQ Job the duration helper needs. */
export interface JobTimestamps {
  /** Epoch ms when the worker picked the job up. Undefined before it starts. */
  processedOn?: number | null;
  /** Epoch ms when the job settled. Undefined while still running. */
  finishedOn?: number | null;
}

/**
 * Processing duration of a BullMQ job in seconds, or `undefined` when it can't
 * be determined.
 *
 * Uses the timestamps BullMQ ALREADY records on every job (`processedOn` /
 * `finishedOn`) rather than a side map of start times. That matters for three
 * reasons: no per-job state to leak if a worker dies mid-job, no extra Redis
 * round trip, and the measured window is exactly the one BullMQ itself considers
 * "processing" — so the histogram agrees with what Bull Board shows.
 *
 * `finishedOn` is not yet set inside the `completed`/`failed` handler for every
 * BullMQ version/path, so a caller may pass an explicit `now`. Returns
 * `undefined` for a missing/implausible pair (negative or non-finite) instead of
 * polluting the histogram with a garbage observation.
 */
export function jobDurationSeconds(
  job: JobTimestamps | undefined,
  now: number = Date.now(),
): number | undefined {
  const started = job?.processedOn;
  if (typeof started !== 'number' || !Number.isFinite(started))
    return undefined;

  const finished =
    typeof job?.finishedOn === 'number' && Number.isFinite(job.finishedOn)
      ? job.finishedOn
      : now;

  const seconds = (finished - started) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
