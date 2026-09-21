---
title: "Basics"
parent: "Usage"
nav_order: 1
---

# Basic usage

---

Croner uses the function `new Cron()` which takes in three arguments:

```ts
const job = new Cron(
    /* The pattern */
    "* * * * * *",
    /* Options (optional) */
    { maxRuns: 1 },
    /* Function (optional) */
    () => {}
);
```

If the function is omitted in the constructor, it can be scheduled later:

```ts
job.schedule(job, /* optional */ context) => {});
```

The job will be scheduled to run at the next matching time unless you supply the option `{ paused: true }`. The `Cron(...)` constructor will return a Cron instance, later referred to as `job`, which have a few methods and properties.

## Status

Check the status of the job using the following methods:

```ts
job.nextRun( /*optional*/ startFromDate );    // Get a Date object representing the next run.
job.nextRuns(10, /*optional*/ startFromDate ); // Get an array of Dates, containing the next n runs.
job.previousRuns(10, /*optional*/ referenceDate ); // Get an array of Dates, containing previous n scheduled runs.
job.msToNext( /*optional*/ startFromDate ); // Get the milliseconds left until the next execution.
job.currentRun();         // Get a Date object showing when the current (or last) run was started.
job.previousRun( );         // Get a Date object showing when the previous job was started.

job.match( date );     // Check if a Date object or date string matches the cron pattern (true or false).

job.isRunning();     // Indicates if the job is scheduled and not paused or killed (true or false).
job.isStopped();     // Indicates if the job is permanently stopped using `stop()` (true or false).
job.isBusy();         // Indicates if the job is currently busy doing work (true or false).

job.getPattern();     // Returns the original cron pattern string, or undefined for date-based jobs
job.getOnce();     // Returns the original run-once date (Date or null)
```

## Tracing the next run

`nextRun()` tells you *when* the next run happens, but not *why*: for example which field skipped a candidate, or whether a candidate landed inside a DST gap. Use `nextRunTrace()` to get the next run together with the bounded list of decision steps the engine took to get there.

```ts
const trace = job.nextRunTrace(
  startFromDate,    // optional, same input types as nextRun()
  { maxSteps: 100 }, // optional, default 1000, hard cap 100000
);
```

The result is plain structured data:

```ts
{
  nextRun: Date,          // identical to nextRun() for the same input (dayOffset applied)
  matched: {              // matched local candidate, before any dayOffset
    year, month, day,     // month/day are 1-based
    hour, minute, second,
  },
  timezone: "normal",     // "normal" | "gap" | "overlap"
                          //   gap: local time does not exist (spring forward)
                          //   overlap: local time exists twice (fall back)
  steps: [
    {
      sequence: 1,
      field: "hour",      // year|month|day|dayOfWeek|hour|minute|second
      reason: "advance",  // tick|advance|rollover
      from: { /* local components before the step */ },
      to:   { /* local components after the step */ },
      timezone: "normal", // conversion classification of the `to` candidate
    },
  ],
  truncated: false,       // true when more steps occurred than maxSteps
  totalSteps: 4,          // full step count, even when the steps array is capped
  maxSteps: 1000,
}
```

Semantics:

- **Shared calculation path.** The tracer is an observer threaded through the exact same `increment` → `recurse` → `findNext` path that `nextRun` uses. It never duplicates the matching logic, so `trace.nextRun` is always the value `nextRun()` returns for the same input.
- **Field attribution.** `tick` is the initial one-second (or `interval`) increment. `advance` means the field moved to its next matching value. `rollover` means the field below ran out of matches and this field (e.g. `day` when the hour range is exhausted) was incremented. A day-level advance driven solely by the day-of-week constraint in legacy OR mode is reported as `dayOfWeek`.
- **DST classification.** Each step and the final match report `normal`, `gap` (missing local time during spring forward) or `overlap` (repeated local time during fall back), including half-hour transitions such as `Australia/Lord_Howe`. The produced instant stays the one `nextRun()` returns; the trace only describes the conversion.
- **Deterministic replay.** Tracing never reads the current time. When you pass a fixed `Date` (or date string) and timezone, the result is reproducible. Decisions are derived from structured numeric components, so different display forms of the same instant (Date, epoch-derived Date, local ISO string, or the two occurrences of an overlap) produce identical field decisions.
- **Bounded memory.** The search always runs to completion, but `steps` never grows beyond `maxSteps` (default `CRON_TRACE_DEFAULT_MAX_STEPS`, capped at `CRON_TRACE_ABSOLUTE_MAX_STEPS`); beyond the cap, `truncated` is set and only `totalSteps` keeps counting.
- **Side effects.** `nextRunTrace()` does not schedule, start timers, update job state, or consume runs. `dayOffset` is reflected in `nextRun` only; `matched` and the steps describe the unshifted pattern match.

Complexity: the trace is O(s) time where s is the number of field decisions the engine makes (identical to `nextRun` plus O(1) observer work per step), with IANA timezone steps additionally performing a constant number of timezone lookups. Memory is O(min(s, maxSteps)). Calling `nextRun()` without tracing has unchanged behavior and no tracing allocations.

## Control Functions

Control the job using the following methods:

```ts
job.trigger();     // Force a trigger instantly
job.pause();       // Pause trigger
job.resume();      // Resume trigger
job.stop();        // Stop the job completely. It is not possible to resume after this.
                   // Note that this also removes named jobs from the exported `scheduledJobs` array.
```

## Properties

```ts
job.name             // Optional job name, populated if a name were passed to options
```
