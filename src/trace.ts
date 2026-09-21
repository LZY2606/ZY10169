/* ------------------------------------------------------------------------------------

  Croner - MIT License - Hexagon <github.com/Hexagon>

  Side-effect-free tracing of the next-run calculation.

  The tracer is threaded through the exact same code path that `nextRun` uses
  (CronDate.increment -> recurse -> findNext), so the recorded steps describe
  the actual field decisions of the engine rather than a re-implementation.

  ------------------------------------------------------------------------------------  */
import { classifyTZ, createTimePoint, type TzConversionKind } from "./helpers/timezone.ts";

/**
 * Structural view of the date parts observed by the tracer. CronDate satisfies
 * this directly; keeping the type structural avoids coupling the tracing types
 * to CronDate's generic context parameter.
 */
interface TraceableDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Fields that can push the candidate forward while searching for the next run.
 *
 * "dayOfWeek" is reported when a day-level advance was driven solely by the
 * day-of-week constraint (legacy OR mode, where the day-of-month did not match
 * but the day-of-week did).
 */
export type CronTraceField =
  | "year"
  | "month"
  | "day"
  | "dayOfWeek"
  | "hour"
  | "minute"
  | "second";

/**
 * Why a field pushed the candidate:
 *
 * - "tick": The initial minimal increment (one second, or `interval` seconds) that
 *   starts every search.
 * - "advance": The field moved forward to its next matching value within its range.
 * - "rollover": The field below exhausted its range without a match, so this field
 *   was incremented and the lower fields were reset.
 */
export type CronTraceReason = "tick" | "advance" | "rollover";

/**
 * How the candidate local time converts through the job timezone.
 * Re-exported from the timezone helpers. "normal" is also reported when no
 * IANA timezone is in use (local time or fixed utcOffset), as fixed offsets
 * never produce gaps or overlaps.
 */
export type CronTraceTimezone = TzConversionKind;

/**
 * A local wall-clock time in the job timezone, using 1-based month and day.
 * This is a structured representation - field decisions never depend on any
 * string or platform-specific display form of an instant.
 */
export interface CronTraceLocalTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/**
 * A single bounded decision step of the next-run search.
 */
export interface CronTraceStep {
  /** 1-based sequence number of the step within the whole search. */
  sequence: number;
  /** The field whose change pushed the candidate forward. */
  field: CronTraceField;
  /** Why the field changed. */
  reason: CronTraceReason;
  /** Candidate local time before this step. */
  from: CronTraceLocalTime;
  /** Candidate local time after this step. */
  to: CronTraceLocalTime;
  /** Timezone conversion classification of the `to` candidate. */
  timezone: CronTraceTimezone;
}

/**
 * Options accepted by `Cron.nextRunTrace`.
 */
export interface CronTraceOptions {
  /**
   * Maximum number of steps stored in the result. The search itself always
   * runs to completion (so `nextRun` stays correct); when the limit is
   * exceeded, `truncated` is set and `totalSteps` keeps counting while
   * `steps` stops growing. Defaults to `CRON_TRACE_DEFAULT_MAX_STEPS`, and is
   * capped at `CRON_TRACE_ABSOLUTE_MAX_STEPS` to keep memory bounded.
   */
  maxSteps?: number;
}

/**
 * Result of `Cron.nextRunTrace`.
 */
export interface CronTraceResult {
  /** Identical to what `nextRun` returns for the same input (dayOffset applied). */
  nextRun: Date | null;
  /** The matched local candidate in the job timezone, before any dayOffset is applied. */
  matched: CronTraceLocalTime | null;
  /** Timezone conversion classification of the matched candidate. */
  timezone: CronTraceTimezone;
  /** Bounded list of decision steps, in order. */
  steps: CronTraceStep[];
  /** True when more steps occurred than `maxSteps` could hold. */
  truncated: boolean;
  /** Total number of decision steps taken, including steps beyond `maxSteps`. */
  totalSteps: number;
  /** The effective step limit used for this trace. */
  maxSteps: number;
}

/**
 * Default upper bound of recorded trace steps.
 */
export const CRON_TRACE_DEFAULT_MAX_STEPS = 1000;

/**
 * Absolute upper bound of recorded trace steps, guarding against unbounded
 * memory growth even when a larger limit is requested.
 */
export const CRON_TRACE_ABSOLUTE_MAX_STEPS = 100000;

/**
 * Collector threaded through the next-run calculation. All methods are no-ops
 * from the perspective of the calculation: they only observe and record, so
 * enabling a trace never changes the computed result.
 */
export class CronTracer {
  private tz: string | number | undefined;
  private steps: CronTraceStep[] = [];
  private totalSteps = 0;
  private maxSteps: number;
  private truncated = false;
  private dayOfWeekDriven = false;

  constructor(tz: string | number | undefined, options?: CronTraceOptions) {
    this.tz = tz;
    const maxSteps = options?.maxSteps ?? CRON_TRACE_DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new TypeError("CronTracer: maxSteps must be a positive integer.");
    }
    this.maxSteps = Math.min(maxSteps, CRON_TRACE_ABSOLUTE_MAX_STEPS);
  }

  /**
   * Take a structured snapshot of the current local components of a CronDate.
   */
  snapshot(date: TraceableDate): CronTraceLocalTime {
    return {
      year: date.year,
      month: date.month + 1,
      day: date.day,
      hour: date.hour,
      minute: date.minute,
      second: date.second,
    };
  }

  /**
   * Called by the matcher when a day-level match was driven solely by the
   * day-of-week constraint. Consumed by the next recorded day step.
   */
  noteDayOfWeekDriven(): void {
    this.dayOfWeekDriven = true;
  }

  /**
   * Record one decision step. Always counts the step, but only stores it while
   * below the configured limit, keeping memory bounded on long searches.
   */
  record(
    field: CronTraceField,
    reason: CronTraceReason,
    from: CronTraceLocalTime,
    date: TraceableDate,
  ): void {
    if (field === "day" && this.dayOfWeekDriven) {
      field = "dayOfWeek";
    }
    this.dayOfWeekDriven = false;

    this.totalSteps++;
    if (this.steps.length >= this.maxSteps) {
      this.truncated = true;
      return;
    }

    const to = this.snapshot(date);
    this.steps.push({
      sequence: this.totalSteps,
      field,
      reason,
      from,
      to,
      timezone: this.classifyLocal(to),
    });
  }

  /**
   * Build the final result. `matched` is the date returned by the internal
   * next-run calculation (or null), `nextRun` is the public Date including any
   * configured dayOffset.
   */
  finish(matched: TraceableDate | null, nextRun: Date | null): CronTraceResult {
    const matchedLocal = matched ? this.snapshot(matched) : null;
    return {
      nextRun,
      matched: matchedLocal,
      timezone: matchedLocal ? this.classifyLocal(matchedLocal) : "normal",
      steps: this.steps,
      truncated: this.truncated,
      totalSteps: this.totalSteps,
      maxSteps: this.maxSteps,
    };
  }

  /**
   * Classify the timezone conversion of a local candidate. Fixed offsets and
   * local time never produce gaps or overlaps, so they report "normal".
   */
  private classifyLocal(local: CronTraceLocalTime): CronTraceTimezone {
    if (typeof this.tz !== "string") {
      return "normal";
    }
    return classifyTZ(
      createTimePoint(
        local.year,
        local.month,
        local.day,
        local.hour,
        local.minute,
        local.second,
        this.tz,
      ),
    );
  }
}
