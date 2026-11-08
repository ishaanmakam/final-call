import { describe, expect, it } from "vitest";
import {
  RULES_VERSION,
  activityMatchesPact,
  activityVerdict,
  computeProgress,
  computeResults,
  goalResult,
  type ActivityInput,
  type ActivityRecord,
  type CheckinRecord,
} from "../src/index";

// Challenge kinds (RULES_VERSION 4): activity verdicts, progress, goal results.

const W_OPEN = "2030-01-07T08:00:00.000Z";
const W_DEADLINE = "2030-01-14T08:00:00.000Z";
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();
let n = 0;
const act = (o: Partial<ActivityRecord> & { startedAt: string }): ActivityRecord => ({
  id: String(++n).padStart(4, "0"),
  userId: "a",
  source: "healthkit",
  externalId: `x${n}`,
  activityType: "running",
  endedAt: plus(o.startedAt, 30),
  distanceM: 5000,
  durationS: 1800,
  steps: null,
  isManual: false,
  verdict: "accepted",
  ...o,
});

describe("activityVerdict", () => {
  const now = plus(W_OPEN, 24 * 60);
  const base: ActivityInput = act({ startedAt: plus(W_OPEN, 60) });
  it("accepts a plain workout", () => {
    expect(activityVerdict(base, [], now)).toEqual({ verdict: "accepted", reason: null });
  });
  it("rejects unknown types before anything else", () => {
    expect(activityVerdict({ ...base, activityType: "skiing", isManual: true }, [], now).verdict).toBe("rejected_type");
  });
  it("rejects hand-entered activities", () => {
    expect(activityVerdict({ ...base, isManual: true }, [], now).verdict).toBe("rejected_manual");
  });
  it("rejects activities ending more than 5 minutes in the future, with 5 minutes of slack", () => {
    expect(activityVerdict({ ...base, startedAt: plus(now, -20), endedAt: plus(now, 6) }, [], now).verdict).toBe("rejected_future");
    expect(activityVerdict({ ...base, startedAt: plus(now, -20), endedAt: plus(now, 5) }, [], now).verdict).toBe("accepted");
  });
  it("rejects an implausible pace per type (12 m/s on foot, 25 m/s cycling); duration null = elapsed", () => {
    expect(activityVerdict({ ...base, distanceM: 24140, durationS: 20 }, [], now)).toEqual({ verdict: "rejected_type", reason: "implausible pace" });
    expect(activityVerdict({ ...base, activityType: "cycling", distanceM: 24140, durationS: 1000 }, [], now).verdict).toBe("accepted");
    expect(activityVerdict({ ...base, activityType: "cycling", distanceM: 26000, durationS: 1000 }, [], now).verdict).toBe("rejected_type");
    expect(activityVerdict({ ...base, activityType: "strength", distanceM: 1e6, durationS: 1 }, [], now).verdict).toBe("accepted");
    expect(activityVerdict({ ...base, distanceM: 30000, durationS: null }, [], now).verdict).toBe("rejected_type"); // 30 km in 30 min
  });
  it("rejects a second source covering at least 80 % of an accepted activity; first accepted wins", () => {
    const hk = act({ startedAt: plus(W_OPEN, 600), endedAt: plus(W_OPEN, 630) });
    const strava: ActivityRecord = { ...hk, source: "strava", externalId: "s1", startedAt: plus(W_OPEN, 602), endedAt: plus(W_OPEN, 631) };
    expect(activityVerdict(strava, [hk], now)).toEqual({ verdict: "rejected_duplicate", reason: `duplicate of healthkit ${hk.externalId}` });
    // 5 of 30 minutes: another activity
    expect(activityVerdict({ ...strava, startedAt: plus(W_OPEN, 625), endedAt: plus(W_OPEN, 655) }, [hk], now).verdict).toBe("accepted");
    // exactly 80 % of the shorter one counts as a duplicate
    expect(activityVerdict({ ...strava, startedAt: plus(W_OPEN, 606), endedAt: plus(W_OPEN, 636) }, [hk], now).verdict).toBe("rejected_duplicate");
    expect(activityVerdict({ ...strava, startedAt: plus(W_OPEN, 607), endedAt: plus(W_OPEN, 637) }, [hk], now).verdict).toBe("accepted");
    // same source, a rejected twin, or a steps sample never block
    expect(activityVerdict({ ...strava, source: "healthkit" }, [hk], now).verdict).toBe("accepted");
    expect(activityVerdict(strava, [{ ...hk, verdict: "rejected_manual" }], now).verdict).toBe("accepted");
    expect(activityVerdict(strava, [{ ...hk, activityType: "steps", steps: 100 }], now).verdict).toBe("accepted");
  });
});

describe("computeProgress and goalResult", () => {
  const win = { openAt: W_OPEN, deadlineAt: W_DEADLINE };
  it("sums accepted activities of the allowed types inside the window and finds the crossing", () => {
    const d1 = plus(W_OPEN, 7 * 60);
    const acts = [
      act({ startedAt: d1, distanceM: 10000 }),
      act({ startedAt: plus(d1, 24 * 60), distanceM: 10000, activityType: "walking" }),
      act({ startedAt: plus(d1, 48 * 60), distanceM: 10000 }),
      act({ startedAt: plus(d1, 72 * 60), distanceM: 5000, endedAt: plus(d1, 72 * 60 + 25) }),
      act({ startedAt: plus(d1, 96 * 60), distanceM: 3000 }),
      act({ startedAt: plus(W_OPEN, -30), distanceM: 10000 }),
      act({ startedAt: W_DEADLINE, distanceM: 10000 }),
      act({ startedAt: plus(d1, 10), distanceM: 10000, verdict: "rejected_manual" }),
    ];
    const p = computeProgress("distance", 24140, ["running"], win, acts);
    expect(p).toEqual({ value: 28000, count: 4, reachedAt: plus(d1, 72 * 60 + 25) });
    expect(goalResult(p, 24140)).toBe("success");
    expect(goalResult(computeProgress("distance", 24140, ["running"], win, acts.slice(0, 3)), 24140)).toBe("failed");
    expect(computeProgress("distance", 24140, ["running", "walking"], win, acts).value).toBe(38000);
  });
  it("orders by start then id, so the crossing activity is the one started earlier even if it ended later", () => {
    const long = act({ startedAt: plus(W_OPEN, 60), endedAt: plus(W_OPEN, 300), distanceM: 20000, durationS: 14400 });
    const short = act({ startedAt: plus(W_OPEN, 90), endedAt: plus(W_OPEN, 120), distanceM: 5000 });
    expect(computeProgress("distance", 20000, ["running"], win, [short, long]).reachedAt).toBe(long.endedAt);
    expect(computeProgress("distance", 25000, ["running"], win, [short, long]).reachedAt).toBe(short.endedAt);
  });
  it("counts workouts of at least 10 minutes only", () => {
    const acts = [
      act({ startedAt: plus(W_OPEN, 60), activityType: "strength", durationS: 1800 }),
      act({ startedAt: plus(W_OPEN, 120), activityType: "yoga", durationS: 599 }),
      act({ startedAt: plus(W_OPEN, 180), activityType: "running", durationS: 600 }),
      act({ startedAt: plus(W_OPEN, 240), activityType: "cycling", durationS: 3600 }),
    ];
    expect(computeProgress("workouts", 3, ["strength", "yoga", "running"], win, acts)).toEqual({ value: 2, count: 2, reachedAt: null });
  });
  it("sums step samples for a steps pact", () => {
    const day = { openAt: W_OPEN, deadlineAt: plus(W_OPEN, 24 * 60 - 1) };
    const acts = [
      act({ startedAt: W_OPEN, activityType: "steps", steps: 6000, distanceM: null }),
      act({ startedAt: W_OPEN, activityType: "running", distanceM: 5000 }),
      act({ startedAt: plus(W_OPEN, 10), activityType: "steps", steps: 4500, distanceM: null, endedAt: plus(W_OPEN, 20) }),
    ];
    expect(computeProgress("steps", 10000, [], day, acts)).toEqual({ value: 10500, count: 2, reachedAt: plus(W_OPEN, 20) });
    expect(activityMatchesPact("steps", [], "running")).toBe(false);
    expect(activityMatchesPact("custom", [], "running")).toBe(false);
  });
});

describe("computeResults for goal kinds", () => {
  const participants = [
    { userId: "a", frozen: false },
    { userId: "b", frozen: false },
    { userId: "c", frozen: false },
  ];
  const d1 = plus(W_OPEN, 7 * 60);
  it("is success at reachedAt or failed, never unverified; evidence submitted after deadline + 24 h does not count", () => {
    const r = computeResults({
      kind: "distance",
      windowOpenAt: W_OPEN,
      deadlineAt: W_DEADLINE,
      goal: 24140,
      activityTypes: ["running"],
      participants,
      activities: [
        act({ userId: "a", startedAt: d1, distanceM: 25000, endedAt: plus(d1, 150), durationS: 9000, submittedAt: plus(d1, 160) }),
        act({ userId: "b", startedAt: d1, distanceM: 10000 }),
        act({ userId: "b", startedAt: plus(d1, 60), distanceM: 15000, submittedAt: plus(W_DEADLINE, 2 * 60) }), // within 24 h
        act({ userId: "c", startedAt: plus(d1, 60), distanceM: 30000, submittedAt: plus(W_DEADLINE, 25 * 60) }), // too late
      ],
    });
    expect(r.voided).toBe(false);
    expect(r.results).toEqual([
      { userId: "a", status: "success", firstSuccessAt: plus(d1, 150) },
      { userId: "b", status: "success", firstSuccessAt: plus(d1, 90) },
      { userId: "c", status: "failed", firstSuccessAt: null },
    ]);
  });
  it("keeps frozen and the void rule", () => {
    const r = computeResults({
      kind: "workouts",
      windowOpenAt: W_OPEN,
      deadlineAt: W_DEADLINE,
      goal: 3,
      activityTypes: ["running"],
      participants: [
        { userId: "a", frozen: true },
        { userId: "b", frozen: false },
      ],
      activities: [act({ userId: "b", startedAt: d1 }), act({ userId: "b", startedAt: plus(d1, 60) }), act({ userId: "b", startedAt: plus(d1, 120) })],
    });
    expect(r.voided).toBe(true);
    expect(r.results.map((x) => x.status)).toEqual(["frozen", "void"]);
  });
  it("custom: success at the mark before the deadline, failed otherwise", () => {
    const r = computeResults({
      kind: "custom",
      deadlineAt: W_DEADLINE,
      participants,
      completions: [
        { userId: "a", markedAt: plus(W_OPEN, 30) },
        { userId: "b", markedAt: plus(W_DEADLINE, 1) },
      ],
    });
    expect(r.results).toEqual([
      { userId: "a", status: "success", firstSuccessAt: plus(W_OPEN, 30) },
      { userId: "b", status: "failed", firstSuccessAt: null },
      { userId: "c", status: "failed", firstSuccessAt: null },
    ]);
  });
  it("defaults to show_up so existing callers are unchanged", () => {
    const ci: CheckinRecord = { userId: "a", verdict: "in_fence", serverReceivedAt: "2026-11-09T16:20:00Z", clientCapturedAt: "2026-11-09T16:20:00Z" };
    const r = computeResults({ deadlineAt: "2026-11-09T17:00:00Z", participants: participants.slice(0, 2), checkins: [ci] });
    expect(r.results.map((x) => x.status)).toEqual(["success", "failed"]);
    expect(RULES_VERSION).toBe(4);
  });
});
