/**
 * Types and internals for the side-effect free next-run tracing API.
 *
 * The trace is produced by the exact same code path as `nextRun()` -
 * an optional `CronTraceSink` is threaded through `CronDate.increment()`
 * and records why each candidate local time was advanced. When no sink is
 * supplied (the default), the hooks are no-ops and `nextRun()` keeps its
 * existing behaviour and performance characteristics.
 */

/**
 * Date/time fields that can drive a candidate forward while searching for
 * the next run. `weekday` is reported instead of `day` when the day-of-month
 * field is a wildcard (`*` or `?`) and the day-of-week field alone decides
 * which day matches.
 */
export type CronTraceField =
  | "year"
  | "month"
  | "day"
  | "weekday"
  | "hour"
  | "minute"
  | "second";

/**
 * What kind of decision a trace step describes:
 *
 * - `seek`    - the initial move away from the reference time (one second, or one `interval`)
 * - `advance` - the field was moved forward to its next matching value
 * - `carry`   - the field found no match within its range, so the parent field was incremented
 * - `reset`   - a subordinate field was reset because a higher-order field changed
 */
export type CronTraceAction = "seek" | "advance" | "carry" | "reset";

/**
 * A single, bounded decision step recorded while searching for the next run.
 */
export interface CronTraceStep {
  /** Which field pushed the candidate forward */
  field: CronTraceField;
  /** The kind of decision */
  action: CronTraceAction;
  /** Field value before the step */
  from: number;
  /** Field value after the step */
  to: number;
  /**
   * Candidate local time after the step, `YYYY-MM-DDTHH:mm:ss` in the job's
   * timezone (or system local time when no timezone is configured).
   */
  candidate: string;
}

/**
 * Classification of how a candidate local time converts through a named
 * (IANA) timezone:
 *
 * - `normal`   - the local time exists exactly once
 * - `missing`  - the local time never occurs (spring-forward gap); the
 *                reported run is adjusted to the first valid instant after the gap
 * - `repeated` - the local time occurs twice (fall-back overlap); the
 *                reported run is the first occurrence
 */
export type CronTraceTimezoneStatus = "normal" | "missing" | "repeated";

/**
 * Timezone diagnostics for the traced run. Only present when the job uses a
 * named IANA timezone and a run was found.
 */
export interface CronTraceTimezone {
  /** IANA timezone name, e.g. `America/New_York` */
  timezone: string;
  /** The matched local time, `YYYY-MM-DDTHH:mm:ss`, before any `dayOffset` is applied */
  localTime: string;
  /** How the local time converts through the timezone */
  status: CronTraceTimezoneStatus;
}

/**
 * Options accepted by `Cron.nextRunTrace()`.
 */
export interface CronTraceOptions {
  /**
   * Maximum number of steps recorded. When the limit is exceeded the search
   * continues unchanged, but recording stops and the result is flagged as
   * truncated. Defaults to 1024. Must be a positive integer.
   */
  maxSteps?: number;
}

/**
 * Result of `Cron.nextRunTrace()`.
 */
export interface CronRunTrace {
  /**
   * The next run time - the exact same value `nextRun()` would return for
   * the same input, including `dayOffset` handling. `null` when there is no
   * next run.
   */
  run: Date | null;
  /** Bounded list of decision steps, in the order they were taken */
  steps: CronTraceStep[];
  /** True when `steps` was cut off at `maxSteps` */
  truncated: boolean;
  /** The step limit in effect for this trace */
  maxSteps: number;
  /** Timezone conversion diagnostics for the matched local time */
  timezone?: CronTraceTimezone;
  /** The `dayOffset` applied to `run`, if any */
  dayOffset?: number;
}

/**
 * Internal sink passed through the increment recursion. Collects steps up to
 * `maxSteps`, then flips to truncated and drops further steps so memory use
 * stays bounded regardless of how long the search runs.
 *
 * @private
 */
export class CronTraceSink {
  steps: CronTraceStep[] = [];
  truncated = false;
  readonly maxSteps: number;

  constructor(maxSteps: number) {
    this.maxSteps = maxSteps;
  }

  record(step: CronTraceStep): void {
    if (this.steps.length >= this.maxSteps) {
      this.truncated = true;
      return;
    }
    this.steps.push(step);
  }
}

/**
 * Resolve and validate the step limit for a trace call.
 *
 * @private
 */
export function resolveMaxSteps(options?: CronTraceOptions): number {
  const maxSteps = options?.maxSteps ?? 1024;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError("Cron: maxSteps must be a positive integer.");
  }
  return maxSteps;
}

/**
 * Format a candidate local time as `YYYY-MM-DDTHH:mm:ss`. Takes the
 * internally 0-based month and renders it 1-based.
 *
 * @private
 */
export function formatTraceCandidate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(year, 4)}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
