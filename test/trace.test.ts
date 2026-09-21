/**
 * Tests for the side-effect-free next-run tracing API (Cron.nextRunTrace)
 *
 * Every test uses fixed input Dates (no real-clock waiting) and asserts that
 * trace.nextRun stays identical to Cron.nextRun for the same input, since both
 * share the exact same internal calculation path.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { test } from "@cross/test";
import { Cron, CRON_TRACE_DEFAULT_MAX_STEPS } from "../src/croner.ts";
import type { CronTraceResult, CronTraceStep } from "../src/croner.ts";

/**
 * Local fixed timestamps are constructed as local Date objects; assertions on
 * the structured matched candidate use local components, so they are stable
 * regardless of the host timezone.
 */
const local = (s: string) => new Date(s);

/** Field/reason decisions in order, e.g. ["second/tick", "hour/advance"]. */
function decisions(trace: CronTraceResult): string[] {
  return trace.steps.map((step: CronTraceStep) => step.field + "/" + step.reason);
}

/** Assert a matched candidate exists and return it, for readable null-failures. */
function m(trace: CronTraceResult): NonNullable<CronTraceResult["matched"]> {
  assert(trace.matched !== null, "expected a matched candidate in trace");
  return trace.matched;
}

/** Assert that trace.nextRun equals nextRun() for the same fixed input. */
function assertParity(
  pattern: string,
  from: Date | string,
  options?: Record<string, unknown>,
  label = pattern,
): CronTraceResult {
  const job = new Cron(pattern, options);
  const trace = job.nextRunTrace(from);
  const expected = job.nextRun(from);
  assertEquals(
    trace.nextRun === null ? null : trace.nextRun.getTime(),
    expected === null ? null : expected.getTime(),
    `${label}: trace.nextRun must equal nextRun()`,
  );
  return trace;
}

// ---------------------------------------------------------------------------
// Structure and basic semantics
// ---------------------------------------------------------------------------

test("trace: shares the nextRun calculation path and reports the matched local time", () => {
  const from = local("2024-03-08T09:15:30");
  const trace = assertParity("0 0 12 * * *", from);

  assertEquals(trace.matched, {
    year: 2024,
    month: 3,
    day: 8,
    hour: 12,
    minute: 0,
    second: 0,
  }, "trace.matched should be the matched local candidate");
  assertEquals(trace.timezone, "normal", "no IANA timezone means normal conversion");
  assertEquals(trace.truncated, false, "short search should not be truncated");
  assertEquals(
    trace.totalSteps,
    trace.steps.length,
    "totalSteps equals stored steps when not truncated",
  );

  assertEquals(
    decisions(trace),
    ["second/tick", "hour/advance"],
    "search from 09:15:30 ticks one second then advances the hour to 12",
  );

  const tick = trace.steps[0];
  assertEquals(tick.sequence, 1);
  assertEquals(tick.to.second, 31, "tick advances the starting second by one");
  assertEquals(tick.from.hour, 9);
  const advance = trace.steps[1];
  assertEquals(advance.field, "hour");
  assertEquals(advance.to.hour, 12, "hour advances to the matching 12");
  assertEquals(advance.to.minute, 0, "lower fields reset on hour advance");
});

test("trace: range pattern rolls over the day and advances inside the range", () => {
  const from = local("2024-03-08T18:00:00");
  const trace = assertParity("0 0 9-17 * * *", from);

  assertEquals(
    trace.matched,
    { year: 2024, month: 3, day: 9, hour: 9, minute: 0, second: 0 },
    "18:00 after the 9-17 range should resolve to next day 09:00",
  );
  assertEquals(
    decisions(trace),
    ["second/tick", "day/rollover", "hour/advance"],
    "exhausted hour range rolls over the day, then hour advances to 9",
  );
});

test("trace: stepping aligns to the first matching step", () => {
  const from = local("2024-03-08T09:15:07");
  const trace = assertParity("*/20 * * * * *", from);

  assertEquals(m(trace).second, 20, "seconds align to the next multiple of 20");
  assertEquals(
    decisions(trace),
    ["second/tick", "second/advance"],
    "second ticks to :08 then advances to :20",
  );
  assertEquals(trace.steps[1].to.second, 20);
});

test("trace: minute stepping advances inside the hour or rolls over the hour", () => {
  // 09:41:30: 46-59 contain no multiple of 20, the minute range rolls the hour over
  const beforeBoundary = assertParity(
    "*/20 * * * *",
    local("2024-03-08T09:41:30"),
    undefined,
    "5-part stepping",
  );
  assertEquals(m(beforeBoundary), {
    year: 2024,
    month: 3,
    day: 8,
    hour: 10,
    minute: 0,
    second: 0,
  }, "09:41:30 with */20 minutes resolves to 10:00");
  assertEquals(decisions(beforeBoundary), ["second/tick", "hour/rollover"]);

  // 09:39:30: minute 40 is still within the current hour
  const insideHour = assertParity(
    "*/20 * * * *",
    local("2024-03-08T09:39:30"),
    undefined,
    "5-part stepping",
  );
  assertEquals(m(insideHour), { year: 2024, month: 3, day: 8, hour: 9, minute: 40, second: 0 });
  assertEquals(
    decisions(insideHour),
    ["second/tick", "minute/advance"],
    "40 is in range, so the minute advances within the same hour",
  );
});

test("trace: question mark is traced identically to the wildcard it aliases", () => {
  const from = local("2024-03-08T09:00:00");
  const withQuestionMark = new Cron("0 0 12 ? * ?").nextRunTrace(from);
  const withStar = new Cron("0 0 12 * * *").nextRunTrace(from);

  assertEquals(
    decisions(withQuestionMark),
    decisions(withStar),
    "? is an alias for *, so field decisions must be identical",
  );
  assertEquals(withQuestionMark.matched, withStar.matched);
});

// ---------------------------------------------------------------------------
// Day-of-month / day-of-week combination semantics
// ---------------------------------------------------------------------------

test("trace: legacy OR mode attributes a weekday-driven day to dayOfWeek", () => {
  // Friday 2024-03-08. Pattern matches the 15th OR any Monday: next is Mon 2024-03-11.
  const from = local("2024-03-08T00:00:00");
  const trace = assertParity("0 0 12 15 * MON", from, { domAndDow: false });

  assertEquals(m(trace).day, 11, "Monday the 11th beats the 15th under OR semantics");
  const dayStep = trace.steps.find((s) => s.field === "day" || s.field === "dayOfWeek");
  assertEquals(
    dayStep?.field,
    "dayOfWeek",
    "day matched solely because of day-of-week, so the push is attributed to dayOfWeek",
  );
});

test("trace: OR mode attributes a month-day-driven day to day", () => {
  // Monday 2024-03-11. Next match for "15th OR Monday" is Friday the 15th (dom-driven).
  const from = local("2024-03-11T13:00:00");
  const trace = assertParity("0 0 12 15 * MON", from, { domAndDow: false });

  assertEquals(m(trace).day, 15);
  const dayStep = trace.steps.find((s) => s.field === "day" || s.field === "dayOfWeek");
  assertEquals(
    dayStep?.field,
    "day",
    "the 15th matched through day-of-month, so the push is attributed to day",
  );
});

test("trace: a wildcard day-of-month constrained by weekday is driven by dayOfWeek", () => {
  // Pattern runs at 12:00 on Mondays only; Friday -> next Monday
  const trace = assertParity("0 0 12 * * MON", local("2024-03-08T00:00:00"));
  assertEquals(m(trace).day, 11);
  const dayStep = trace.steps.find((s) => s.field === "day" || s.field === "dayOfWeek");
  assertEquals(
    dayStep?.field,
    "dayOfWeek",
    "with a wildcard day-of-month, the weekday constraint drives the day push",
  );
});

test("trace: nth weekday of month is driven by dayOfWeek", () => {
  // Third Friday of the month at 12:00
  const trace = assertParity("0 0 12 * * FRI#3", local("2024-03-01T00:00:00"));
  assertEquals(m(trace), { year: 2024, month: 3, day: 15, hour: 12, minute: 0, second: 0 });
  const dayStep = trace.steps.find((s) => s.field === "day" || s.field === "dayOfWeek");
  assertEquals(dayStep?.field, "dayOfWeek");
});

test("trace: AND option (domAndDow) requires both constraints", () => {
  const from = local("2024-01-01T00:00:00");
  const trace = assertParity("0 0 12 13 * FRI", from, { domAndDow: true });

  // First Friday the 13th of 2024 is September 13th
  assertEquals(m(trace).month, 9);
  assertEquals(m(trace).day, 13);
});

test("trace: OCPS 1.4 + modifier enforces AND logic", () => {
  // Next 1st that is also a Monday after 2024-03-08 is April 1st 2024
  const trace = assertParity("0 0 12 1 * +MON", local("2024-03-08T00:00:00"));
  assertEquals(trace.matched, { year: 2024, month: 4, day: 1, hour: 12, minute: 0, second: 0 });
});

test("trace: explicit year field produces a year advance step", () => {
  const trace = assertParity("0 0 12 1 6 * 2025", local("2024-06-01T00:00:00"));
  assertEquals(m(trace).year, 2025);
  assertEquals(
    decisions(trace).includes("year/advance"),
    true,
    "skipping to the year 2025 must be visible as a year/advance step",
  );
});

test("trace: year field in the past yields null", () => {
  const trace = assertParity("0 0 12 1 1 * 2020", local("2024-01-01T00:00:00"));
  assertEquals(trace.nextRun, null);
  assertEquals(trace.matched, null);
  assertEquals(trace.timezone, "normal");
});

// ---------------------------------------------------------------------------
// Month-end semantics
// ---------------------------------------------------------------------------

test("trace: last day of month resolves February to the 29th in a leap year", () => {
  const trace = assertParity("0 0 0 L * *", local("2024-02-15T12:00:00"));
  assertEquals(trace.matched, { year: 2024, month: 2, day: 29, hour: 0, minute: 0, second: 0 });
});

test("trace: day 31 normalizes through February into March 31st", () => {
  const trace = assertParity("0 0 0 31 * *", local("2024-02-15T00:00:00"));
  assertEquals(trace.matched, { year: 2024, month: 3, day: 31, hour: 0, minute: 0, second: 0 });
  // February 31st normalizes to March 2nd, after which the day advances to the 31st again
  assertEquals(
    decisions(trace),
    ["second/tick", "day/advance", "day/advance"],
    "the impossible Feb 31st normalizes and the search re-aligns to March 31st",
  );
});

// ---------------------------------------------------------------------------
// dayOffset and one-off jobs
// ---------------------------------------------------------------------------

test("trace: dayOffset shifts nextRun but not the matched candidate or field decisions", () => {
  const from = local("2024-03-08T09:00:00");
  const offset = new Cron("0 0 12 * * *", { dayOffset: 1 });
  const plain = new Cron("0 0 12 * * *");
  const trace = offset.nextRunTrace(from);

  assertEquals(
    trace.nextRun?.getTime(),
    offset.nextRun(from)?.getTime(),
    "trace.nextRun includes the dayOffset, same as nextRun()",
  );
  assertEquals(trace.nextRun?.getDate(), 9, "public run is shifted one day forward");
  assertEquals(m(trace).day, 8, "matched candidate is the actual pattern match day");
  assertEquals(
    decisions(trace),
    decisions(plain.nextRunTrace(from)),
    "dayOffset does not alter any field decision",
  );
});

test("trace: one-off date jobs report the date with no field steps", () => {
  const once = new Date("2030-01-01T00:00:00");
  const job = new Cron(once);
  const trace = job.nextRunTrace(local("2024-01-01T00:00:00"));

  assertEquals(trace.steps.length, 0, "run-once jobs do not go through increment");
  assertEquals(trace.matched, { year: 2030, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
  assertEquals(trace.nextRun?.getTime(), job.nextRun(local("2024-01-01T00:00:00"))?.getTime());
});

// ---------------------------------------------------------------------------
// Timezone conversions: DST gap, overlap and half-hour transitions
// ---------------------------------------------------------------------------

test("trace: spring-forward gap is classified as gap in America/New_York", () => {
  // 02:30 on 2024-03-10 does not exist in New York (clocks jump 02:00 -> 03:00)
  const from = new Date("2024-03-01T00:00:00Z");
  const trace = assertParity("0 30 2 10 3 *", from, { timezone: "America/New_York" });

  assertEquals(
    trace.matched,
    { year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0 },
    "the matched local candidate is the nonexistent 02:30 wall time",
  );
  assertEquals(trace.timezone, "gap", "nonexistent local time must be reported as a gap");
  assertEquals(
    trace.nextRun?.toISOString(),
    "2024-03-10T07:30:00.000Z",
    "the produced instant is the same adjusted time nextRun() returns",
  );

  // From the moment the candidate enters the gap, every later step is a gap
  const gapSteps = trace.steps.filter((s) => s.to.month === 3 && s.to.day === 10 && s.to.hour >= 2);
  assertEquals(gapSteps.length > 0, true, "at least one step reaches the gap day");
  assertEquals(
    gapSteps.every((s) => s.timezone === "gap"),
    true,
    "steps landing on the nonexistent 02:xx wall time are all classified as gap",
  );
});

test("trace: fall-back overlap is classified as overlap in America/New_York", () => {
  // 01:30 on 2024-11-03 occurs twice in New York (EDT first, EST second)
  const from = new Date("2024-11-01T00:00:00Z");
  const trace = assertParity("0 30 1 3 11 *", from, { timezone: "America/New_York" });

  assertEquals(trace.matched, { year: 2024, month: 11, day: 3, hour: 1, minute: 30, second: 0 });
  assertEquals(trace.timezone, "overlap", "repeated local time must be reported as overlap");
  assertEquals(
    trace.nextRun?.toISOString(),
    "2024-11-03T05:30:00.000Z",
    "first occurrence (EDT) is returned, identical to nextRun()",
  );
});

test("trace: half-hour DST gap is detected (Australia/Lord_Howe)", () => {
  // Lord Howe springs forward by 30 minutes: 2024-10-06 02:00-02:29 does not exist
  const from = new Date("2024-10-01T00:00:00Z");
  const trace = assertParity("0 15 2 6 10 *", from, { timezone: "Australia/Lord_Howe" });

  assertEquals(trace.matched, { year: 2024, month: 10, day: 6, hour: 2, minute: 15, second: 0 });
  assertEquals(trace.timezone, "gap", "the 30-minute spring-forward gap must be detected");
});

test("trace: half-hour DST overlap is detected (Australia/Lord_Howe)", () => {
  // Lord Howe falls back by 30 minutes: 2024-04-07 01:30-01:59 occurs twice
  const from = new Date("2024-04-01T00:00:00Z");
  const trace = assertParity("0 45 1 7 4 *", from, { timezone: "Australia/Lord_Howe" });

  assertEquals(trace.matched, { year: 2024, month: 4, day: 7, hour: 1, minute: 45, second: 0 });
  assertEquals(trace.timezone, "overlap", "the 30-minute fall-back overlap must be detected");
});

test("trace: fixed utcOffset never reports gaps or overlaps", () => {
  const from = new Date("2024-03-01T00:00:00Z");
  const trace = assertParity("0 30 2 10 3 *", from, { utcOffset: -300 });
  assertEquals(trace.timezone, "normal", "fixed offsets have no DST transitions");
  assertEquals(trace.steps.every((s) => s.timezone === "normal"), true);
});

// ---------------------------------------------------------------------------
// Bounded trace length and truncation diagnostics
// ---------------------------------------------------------------------------

test("trace: impossible pattern is bounded and reports truncation", () => {
  // February 31st can never match; the search walks years until the engine limit
  const from = local("2024-01-01T00:00:00");
  const job = new Cron("0 0 0 31 2 *");
  const trace = job.nextRunTrace(from, { maxSteps: 25 });

  assertEquals(trace.nextRun, null);
  assertEquals(job.nextRun(from), null, "nextRun also gives null for the impossible pattern");
  assertEquals(trace.truncated, true, "long search must be flagged as truncated");
  assertEquals(trace.steps.length, 25, "stored steps never exceed the requested limit");
  assertEquals(trace.maxSteps, 25);
  assertEquals(
    trace.totalSteps > 25,
    true,
    "totalSteps keeps counting beyond the limit for diagnostics",
  );
  assertEquals(trace.steps[24].sequence, 25, "sequences remain contiguous in the stored prefix");
});

test("trace: default limit also bounds the steps array", () => {
  const job = new Cron("0 0 0 31 2 *");
  const trace = job.nextRunTrace(local("2024-01-01T00:00:00"));
  assertEquals(
    trace.steps.length,
    CRON_TRACE_DEFAULT_MAX_STEPS,
    "without an explicit limit the default bound still applies",
  );
  assertEquals(trace.truncated, true);
});

test("trace: invalid maxSteps throws", () => {
  const job = new Cron("* * * * * *");
  assertThrows(
    () => job.nextRunTrace(local("2024-01-01T00:00:00"), { maxSteps: 0 }),
    TypeError,
    "positive integer",
  );
  assertThrows(
    () => job.nextRunTrace(local("2024-01-01T00:00:00"), { maxSteps: 1.5 }),
    TypeError,
    "positive integer",
  );
});

// ---------------------------------------------------------------------------
// Determinism: replay stability and display-form independence
// ---------------------------------------------------------------------------

test("trace: fixed Date and timezone can be replayed identically", () => {
  const job = new Cron("0 0 12 * * *");
  const from = local("2024-03-08T09:15:30");
  const first = job.nextRunTrace(from);
  const second = job.nextRunTrace(from);

  assertEquals(first, second, "repeated traces with the same input are deeply equal");
});

test("trace: different display forms of the same instant yield identical decisions", () => {
  const job = new Cron("0 0 12 * * *");
  const instant = local("2024-03-08T09:15:30");

  const fromDate = job.nextRunTrace(instant);
  const fromEpochs = job.nextRunTrace(new Date(instant.getTime()));
  const fromString = job.nextRunTrace("2024-03-08T09:15:30");

  assertEquals(fromDate.steps, fromEpochs.steps, "Date vs epoch-derived Date");
  assertEquals(fromDate.steps, fromString.steps, "Date vs local ISO string");
});

test("trace: overlap occurrences with identical local form share field decisions", () => {
  // 2024-11-03 01:30 in New York exists twice: 05:30Z (EDT) and 06:30Z (EST)
  const job = new Cron("0 30 1 * * *", { timezone: "America/New_York" });
  const firstOccurrence = job.nextRunTrace(new Date("2024-11-03T05:30:00Z"));
  const secondOccurrence = job.nextRunTrace(new Date("2024-11-03T06:30:00Z"));

  assertEquals(
    decisions(firstOccurrence),
    decisions(secondOccurrence),
    "both displays of the repeated local time push the same fields",
  );
  assertEquals(
    firstOccurrence.matched,
    secondOccurrence.matched,
    "both resolve to the same next local candidate",
  );
  assertEquals(
    firstOccurrence.nextRun?.getTime(),
    secondOccurrence.nextRun?.getTime(),
    "both resolve to the same next instant",
  );
});

// ---------------------------------------------------------------------------
// Broad parity with nextRun across pattern features
// ---------------------------------------------------------------------------

test("trace: nextRun parity across a battery of patterns and start dates", () => {
  const patterns = [
    "* * * * * *",
    "0 0 0 * * *",
    "0 */15 9-17 * * 1-5",
    "0 0 12 1,15 * *",
    "0 3-59/7 * * * *",
    "0 30 */2 * * *",
    "0 0 0 L * *",
    "0 0 0 LW * *",
    "0 0 0 15W * *",
    "0 0 12 ? * FRI",
    "0 0 12 * JAN-DEC *",
    "30 0-29/30 * * * *",
  ];
  const starts = [
    "2024-01-01T00:00:00",
    "2024-02-28T23:59:30",
    "2024-03-08T09:15:30",
    "2024-06-30T12:30:00",
    "2024-12-31T23:59:59",
  ];

  for (const pattern of patterns) {
    for (const start of starts) {
      const job = new Cron(pattern);
      const trace = job.nextRunTrace(local(start));
      const expected = job.nextRun(local(start));
      assertEquals(
        trace.nextRun === null ? null : trace.nextRun.getTime(),
        expected === null ? null : expected.getTime(),
        `parity failed for pattern "${pattern}" from ${start}`,
      );
      assertEquals(
        trace.totalSteps,
        trace.steps.length,
        `battery pattern "${pattern}" from ${start} should not truncate`,
      );
    }
  }
});

test("trace: interval option stays on the shared path", () => {
  const from = local("2024-03-08T09:00:00");
  const job = new Cron("0 * * * * *", { interval: 90 });
  const trace = job.nextRunTrace(from);

  assertEquals(
    trace.nextRun?.getTime(),
    job.nextRun(from)?.getTime(),
    "interval option must not diverge from nextRun()",
  );
  const tick = trace.steps[0];
  assertEquals(tick.to.second, 30, "the first tick respects the 90 second interval (00 -> 30)");
});

test("trace: timezone parity across DST-adjacent fixed dates and zones", () => {
  const zones = ["America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Kolkata"];
  const starts = [
    "2024-03-01T00:00:00Z",
    "2024-03-09T23:30:00Z",
    "2024-11-02T23:30:00Z",
    "2024-12-31T23:59:59Z",
  ];
  const patterns = ["0 * * * * *", "30 0 12 * * *", "0 0 0 * * 1-5"];

  for (const timezone of zones) {
    for (const pattern of patterns) {
      for (const start of starts) {
        const job = new Cron(pattern, { timezone });
        const from = new Date(start);
        const trace = job.nextRunTrace(from);
        const expected = job.nextRun(from);
        assertEquals(
          trace.nextRun === null ? null : trace.nextRun.getTime(),
          expected === null ? null : expected.getTime(),
          `tz parity failed for ${pattern} in ${timezone} from ${start}`,
        );
        for (const step of trace.steps) {
          assertEquals(
            ["normal", "gap", "overlap"].includes(step.timezone),
            true,
            `${timezone}: every step timezone must be a known classification`,
          );
        }
      }
    }
  }
});
