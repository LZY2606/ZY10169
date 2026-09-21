import { assert, assertEquals, assertThrows } from "@std/assert";
import { test } from "@cross/test";
import { Cron } from "../src/croner.ts";

/**
 * Tests for the side-effect free next-run tracing API (`nextRunTrace`).
 *
 * All tests use fixed input dates and explicit timezones, so they are
 * replayable and independent of the system clock and local timezone.
 */

test("trace: run is identical to nextRun for the same input", function () {
  const patterns = [
    "0 30 9 * * MON",
    "0 */15 9-17 * * *",
    "0 0 12 ? * *",
    "0 0 0 29 2 *",
    "0 0 0 L * *",
    "0 0 0 13 * 5",
    "15 30 4 1 1 * 2030",
  ];
  const from = new Date("2024-03-08T12:00:00Z");
  for (const pattern of patterns) {
    const job = new Cron(pattern, { timezone: "Etc/UTC" });
    const trace = job.nextRunTrace(from);
    const expected = job.nextRun(from);
    assertEquals(
      trace.run?.getTime(),
      expected?.getTime(),
      `trace.run must equal nextRun for pattern '${pattern}'`,
    );
  }
});

test("trace: identifies the weekday field when day-of-week drives the candidate", function () {
  const job = new Cron("0 0 9 * * MON", { timezone: "Etc/UTC" });
  const trace = job.nextRunTrace(new Date("2024-03-08T00:00:00Z")); // Friday

  assertEquals(trace.run?.toISOString(), "2024-03-11T09:00:00.000Z");
  const weekdayStep = trace.steps.find((s) => s.field === "weekday" && s.action === "advance");
  assert(weekdayStep, "expected a 'weekday' advance step, got: " + JSON.stringify(trace.steps));
  assertEquals(weekdayStep.from, 8);
  assertEquals(weekdayStep.to, 11);
});

test("trace: identifies the driving field for range/step patterns", function () {
  const job = new Cron("0 */15 9-17 * * *", { timezone: "Etc/UTC" });
  const trace = job.nextRunTrace(new Date("2024-03-08T08:50:00Z"));

  assertEquals(trace.run?.toISOString(), "2024-03-08T09:00:00.000Z");
  // Minute 50 matches nothing in */15, so the hour advances to the next
  // value in the 9-17 range and minute/second are reset
  const hourStep = trace.steps.find((s) => s.field === "hour" && s.action === "advance");
  assert(hourStep, "expected an 'hour' advance step, got: " + JSON.stringify(trace.steps));
  assertEquals(hourStep.from, 8);
  assertEquals(hourStep.to, 9);
  const minuteReset = trace.steps.find((s) => s.field === "minute" && s.action === "reset");
  assert(minuteReset, "expected a 'minute' reset step, got: " + JSON.stringify(trace.steps));
  // The first step is always the initial one-second seek
  assertEquals(trace.steps[0].field, "second");
  assertEquals(trace.steps[0].action, "seek");
});

test("trace: question mark behaves like wildcard and reports day field", function () {
  const from = new Date("2024-03-08T13:00:00Z");
  const withQuestion = new Cron("0 0 12 ? * *", { timezone: "Etc/UTC" }).nextRunTrace(from);
  const withStar = new Cron("0 0 12 * * *", { timezone: "Etc/UTC" }).nextRunTrace(from);

  assertEquals(withQuestion.run?.getTime(), withStar.run?.getTime());
  assertEquals(
    withQuestion.steps,
    withStar.steps,
    "? and * must produce identical decision steps",
  );
  const dayStep = withQuestion.steps.find((s) => s.field === "day" && s.action === "carry");
  assert(dayStep, "expected a 'day' carry step, got: " + JSON.stringify(withQuestion.steps));
});

test("trace: dayOffset is applied to run and reported, localTime stays un-offset", function () {
  const job = new Cron("0 0 12 * * *", { timezone: "Etc/UTC", dayOffset: 1 });
  const from = new Date("2024-03-08T13:00:00Z");
  const trace = job.nextRunTrace(from);

  assertEquals(trace.run?.getTime(), job.nextRun(from)?.getTime());
  assertEquals(trace.run?.toISOString(), "2024-03-10T12:00:00.000Z");
  assertEquals(trace.dayOffset, 1);
  // The matched local time is the pre-offset schedule time
  assertEquals(trace.timezone?.localTime, "2024-03-09T12:00:00");
});

test("trace: OCPS 1.2 year field is reported when it drives the candidate", function () {
  const job = new Cron("0 0 0 1 1 * 2030", { timezone: "Etc/UTC" });
  const trace = job.nextRunTrace(new Date("2024-06-15T00:00:00Z"));

  assertEquals(trace.run?.toISOString(), "2030-01-01T00:00:00.000Z");
  const yearStep = trace.steps.find((s) => s.field === "year");
  assert(yearStep, "expected a 'year' step, got: " + JSON.stringify(trace.steps));
  assertEquals(yearStep.to, 2030);
});

test("trace: OCPS 1.4 domAndDow AND semantics find next friday the 13th", function () {
  const job = new Cron("0 0 0 13 * 5", { timezone: "Etc/UTC", domAndDow: true });
  const from = new Date("2024-04-01T00:00:00Z");
  const trace = job.nextRunTrace(from);

  assertEquals(trace.run?.getTime(), job.nextRun(from)?.getTime());
  assertEquals(trace.run?.toISOString(), "2024-09-13T00:00:00.000Z");
});

test("trace: legacy OR semantics for day-of-month and day-of-week", function () {
  const job = new Cron("0 0 0 13 * 5", { timezone: "Etc/UTC" });
  const from = new Date("2024-04-01T00:00:00Z");
  const trace = job.nextRunTrace(from);

  // OR: next friday (2024-04-05) comes before the 13th
  assertEquals(trace.run?.getTime(), job.nextRun(from)?.getTime());
  assertEquals(trace.run?.toISOString(), "2024-04-05T00:00:00.000Z");
});

test("trace: OCPS 1.4 + modifier enforces AND logic", function () {
  const job = new Cron("0 0 0 13 * +5", { timezone: "Etc/UTC" });
  const from = new Date("2024-04-01T00:00:00Z");
  const trace = job.nextRunTrace(from);

  assertEquals(trace.run?.getTime(), job.nextRun(from)?.getTime());
  assertEquals(trace.run?.toISOString(), "2024-09-13T00:00:00.000Z");
});

test("trace: month end skips february for day 31 patterns", function () {
  const job = new Cron("0 0 0 31 * *", { timezone: "Etc/UTC" });
  const trace = job.nextRunTrace(new Date("2024-02-01T00:00:00Z"));

  assertEquals(trace.run?.toISOString(), "2024-03-31T00:00:00.000Z");
  // The day field drives the search: it first lands on the (non-existent)
  // Feb 31 candidate, which normalizes into March, then settles on Mar 31
  const dayAdvances = trace.steps.filter((s) => s.field === "day" && s.action === "advance");
  assert(
    dayAdvances.length >= 1,
    "expected 'day' advance steps, got: " + JSON.stringify(trace.steps),
  );
  assert(
    trace.steps.some((s) => s.candidate.startsWith("2024-03-31")),
    "expected a candidate on 2024-03-31, got: " + JSON.stringify(trace.steps),
  );
});

test("trace: L modifier matches last day of month including leap day", function () {
  const job = new Cron("0 0 0 L * *", { timezone: "Etc/UTC" });
  const trace = job.nextRunTrace(new Date("2024-02-01T00:00:00Z"));

  assertEquals(trace.run?.toISOString(), "2024-02-29T00:00:00.000Z");
});

test("trace: spring forward reports missing local time", function () {
  const job = new Cron("0 30 2 * * *", { timezone: "America/New_York" });
  const trace = job.nextRunTrace(new Date("2024-03-09T12:00:00Z"));

  assertEquals(trace.run?.getTime(), job.nextRun(new Date("2024-03-09T12:00:00Z"))?.getTime());
  assertEquals(trace.timezone?.localTime, "2024-03-10T02:30:00");
  assertEquals(
    trace.timezone?.status,
    "missing",
    "02:30 does not exist on 2024-03-10 in America/New_York",
  );
  // Adjusted to the first valid instant after the gap
  assertEquals(trace.run?.toISOString(), "2024-03-10T07:30:00.000Z");
});

test("trace: fall back reports repeated local time and picks first occurrence", function () {
  const job = new Cron("0 30 1 * * *", { timezone: "America/New_York" });
  const trace = job.nextRunTrace(new Date("2024-11-02T12:00:00Z"));

  assertEquals(trace.timezone?.localTime, "2024-11-03T01:30:00");
  assertEquals(
    trace.timezone?.status,
    "repeated",
    "01:30 occurs twice on 2024-11-03 in America/New_York",
  );
  // First occurrence (EDT, UTC-4)
  assertEquals(trace.run?.toISOString(), "2024-11-03T05:30:00.000Z");
});

test("trace: half-hour DST spring gap (Australia/Lord_Howe)", function () {
  const job = new Cron("0 15 2 * * *", { timezone: "Australia/Lord_Howe" });
  const trace = job.nextRunTrace(new Date("2024-10-05T12:00:00Z"));

  assertEquals(trace.timezone?.localTime, "2024-10-06T02:15:00");
  assertEquals(
    trace.timezone?.status,
    "missing",
    "02:15 does not exist on 2024-10-06 in Australia/Lord_Howe",
  );
});

test("trace: half-hour DST fall overlap (Australia/Lord_Howe)", function () {
  const job = new Cron("0 45 1 * * *", { timezone: "Australia/Lord_Howe" });
  const trace = job.nextRunTrace(new Date("2024-04-06T12:00:00Z"));

  assertEquals(trace.timezone?.localTime, "2024-04-07T01:45:00");
  assertEquals(
    trace.timezone?.status,
    "repeated",
    "01:45 occurs twice on 2024-04-07 in Australia/Lord_Howe",
  );
});

test("trace: normal timezone conversion is reported as normal", function () {
  const job = new Cron("0 0 12 * * *", { timezone: "Europe/Stockholm" });
  const trace = job.nextRunTrace(new Date("2024-06-15T00:00:00Z"));

  assertEquals(trace.timezone?.status, "normal");
  assertEquals(trace.timezone?.timezone, "Europe/Stockholm");
});

test("trace: no timezone diagnostics without a named timezone", function () {
  const job = new Cron("0 0 12 * * *", { utcOffset: 60 });
  const trace = job.nextRunTrace(new Date("2024-06-15T00:00:00Z"));
  assertEquals(trace.timezone, undefined);
});

test("trace: steps are bounded and flagged when exceeding maxSteps", function () {
  const job = new Cron("0 0 0 29 2 *", { timezone: "Etc/UTC" });
  const from = new Date("2024-01-01T00:00:00Z");
  const trace = job.nextRunTrace(from, { maxSteps: 5 });

  assertEquals(trace.truncated, true);
  assertEquals(trace.steps.length, 5);
  assertEquals(trace.maxSteps, 5);
  // The run itself is still computed correctly
  assertEquals(trace.run?.getTime(), job.nextRun(from)?.getTime());
  assertEquals(trace.run?.toISOString(), "2024-02-29T00:00:00.000Z");
});

test("trace: impossible pattern returns null run with bounded steps", function () {
  const job = new Cron("0 0 0 31 2 *", { timezone: "Etc/UTC" });
  const trace = job.nextRunTrace(new Date("2024-01-01T00:00:00Z"), { maxSteps: 100 });

  assertEquals(trace.run, null);
  assert(trace.steps.length <= 100, "steps must stay bounded even when no run is found");
});

test("trace: maxSteps must be a positive integer", function () {
  const job = new Cron("0 0 12 * * *");
  const from = new Date("2024-01-01T00:00:00Z");
  assertThrows(() => job.nextRunTrace(from, { maxSteps: 0 }), TypeError);
  assertThrows(() => job.nextRunTrace(from, { maxSteps: -3 }), TypeError);
  assertThrows(() => job.nextRunTrace(from, { maxSteps: 1.5 }), TypeError);
});

test("trace: same instant in different display forms yields identical steps", function () {
  const job = new Cron("0 30 9 * * MON", { timezone: "America/New_York" });
  const asDate = job.nextRunTrace(new Date("2024-03-08T12:00:00Z"));
  const asIsoZ = job.nextRunTrace("2024-03-08T12:00:00.000Z");
  const asIsoOffset = job.nextRunTrace("2024-03-08T21:00:00+09:00");

  assertEquals(asIsoZ.run?.getTime(), asDate.run?.getTime());
  assertEquals(asIsoOffset.run?.getTime(), asDate.run?.getTime());
  assertEquals(
    asIsoZ.steps,
    asDate.steps,
    "ISO string with Z must produce the same field decisions as a Date",
  );
  assertEquals(
    asIsoOffset.steps,
    asDate.steps,
    "ISO string with offset must produce the same field decisions as a Date",
  );
});

test("trace: is replayable and has no side effects on the job", function () {
  const job = new Cron("0 30 9 * * MON", { timezone: "America/New_York" });
  const from = new Date("2024-03-08T12:00:00Z");

  const first = job.nextRunTrace(from);
  const second = job.nextRunTrace(from);
  assertEquals(second.run?.getTime(), first.run?.getTime());
  assertEquals(second.steps, first.steps);

  // Job state is untouched
  assertEquals(job.currentRun(), null);
  assertEquals(job.previousRun(), null);
  assertEquals(job.nextRun(from)?.getTime(), first.run?.getTime());
});

test("trace: one-off jobs report the run without steps", function () {
  const job = new Cron(new Date("2030-01-01T00:00:00Z"), { timezone: "Etc/UTC" });
  const trace = job.nextRunTrace(new Date("2024-01-01T00:00:00Z"));

  assertEquals(trace.run?.toISOString(), "2030-01-01T00:00:00.000Z");
  assertEquals(trace.steps.length, 0);

  const past = job.nextRunTrace(new Date("2031-01-01T00:00:00Z"));
  assertEquals(past.run, null);
});
