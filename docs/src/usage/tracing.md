---
title: "Tracing"
parent: "Usage"
nav_order: 4
---

# Tracing the next run

---

`nextRun()` and `nextRuns()` tell you *when* a job fires next, but not *why* a
particular local time was chosen - which is exactly what you need when a
candidate is skipped by a pattern field, or when a local time falls into a DST
gap or overlap. `nextRunTrace()` answers that question without any side
effects.

```ts
const job = new Cron("0 30 2 * * *", { timezone: "America/New_York" });
const trace = job.nextRunTrace(new Date("2024-03-09T12:00:00Z"), { maxSteps: 1024 });
```

## Semantics

`nextRunTrace(startFromDate?, options?)` runs the **exact same code path** as
`nextRun()` - the trace hooks observe the real increment recursion instead of
re-interpreting the pattern. As a consequence:

- `trace.run` is always identical to `nextRun(startFromDate)`, including
  `dayOffset` handling, and is `null` when there is no next run.
- The trace is deterministic: for a fixed input date, pattern, options and
  timezone it can be replayed any number of times with identical results. The
  trace itself never reads the system clock (passing no date falls back to
  "now", exactly like `nextRun()`).
- The same instant produces the same field decisions regardless of how the
  input is written (`Date`, ISO 8601 string with `Z` or with a numeric
  offset), because decisions are made on internal date/time fields, not on
  display strings.
- The job's state is untouched: no timers are started, `currentRun()` and
  `previousRun()` are unaffected, and `maxRuns` is not consumed.

### Result shape

```ts
interface CronRunTrace {
  run: Date | null;            // Same value nextRun() would return
  steps: CronTraceStep[];      // Bounded decision steps, in order
  truncated: boolean;          // True when steps were cut off at maxSteps
  maxSteps: number;            // The step limit in effect
  timezone?: {                 // Only for named IANA timezones, when run !== null
    timezone: string;          // e.g. "America/New_York"
    localTime: string;         // Matched local time, before any dayOffset
    status: "normal" | "missing" | "repeated";
  };
  dayOffset?: number;          // The dayOffset applied to run, if any
}

interface CronTraceStep {
  field: "year" | "month" | "day" | "weekday" | "hour" | "minute" | "second";
  action: "seek" | "advance" | "carry" | "reset";
  from: number;                // Field value before the step
  to: number;                  // Field value after the step
  candidate: string;           // Local time after the step, YYYY-MM-DDTHH:mm:ss
}
```

- `field` names the field that pushed the candidate forward. `weekday` is
  reported instead of `day` when day-of-month is a wildcard (`*` or `?`) and
  day-of-week alone decides which day matches.
- `action` describes the decision: `seek` (the initial move away from the
  reference time), `advance` (the field moved to its next matching value),
  `carry` (no match remained in the field's range, so the parent field was
  incremented) and `reset` (a subordinate field was reset after a
  higher-order field changed).
- `timezone.status` classifies the matched local time: `normal` (exists
  exactly once), `missing` (never occurs - a spring-forward gap; the run is
  adjusted to the first valid instant after the gap) or `repeated` (occurs
  twice - a fall-back overlap; the run is the first occurrence). Half-hour
  DST transitions (e.g. `Australia/Lord_Howe`) are detected as well.

## Bounding and complexity

Tracing does not change the asymptotic cost of finding the next run; it only
records what the search already decided. Recording is bounded by `maxSteps`
(default `1024`, must be a positive integer): once the limit is reached,
recording stops, `truncated` is set to `true`, and the search continues
unaffected. Memory usage is therefore O(`maxSteps`) regardless of the
pattern - even for impossible patterns that search all the way to the year
limit and return `run: null`.

When no trace is requested, `nextRun()`/`nextRuns()` keep their existing
behaviour and performance: the trace sink is an optional parameter and every
hook is a no-op without it.

## Compatibility

- `nextRunTrace()` is purely additive. No existing method signatures,
  return values or scheduling behaviour change.
- It works across all supported runtimes (Node.js, Deno, Bun, browsers) and
  relies only on `Intl.DateTimeFormat`, like the rest of the timezone
  handling.
- One-off jobs (created with a `Date` or ISO 8601 string) return the run (or
  `null`) with an empty `steps` list.
- Jobs using `utcOffset` instead of a named timezone never observe DST gaps
  or overlaps, so `timezone` diagnostics are omitted.
