import { describe, expect, it } from "vitest";
import {
  checkinVerdict,
  computeInstancePayout,
  computeResults,
  distanceMeters,
  simplifyDebts,
  type CheckinRecord,
} from "../src/index";

const place = { lat: 47.6566, lng: -122.3091, radiusM: 60 };

describe("distanceMeters", () => {
  it("is zero for identical points", () => {
    expect(distanceMeters(47.6, -122.3, 47.6, -122.3)).toBe(0);
  });
  it("is about 685 m for 0.0091 degrees of longitude at Seattle", () => {
    const d = distanceMeters(47.6566, -122.3091, 47.6566, -122.3);
    expect(d).toBeGreaterThan(680);
    expect(d).toBeLessThan(690);
  });
});

describe("checkinVerdict", () => {
  const fix = { lat: place.lat, lng: place.lng, accuracyM: 20, isSimulated: false };
  it("is in_fence at the center", () => {
    expect(checkinVerdict(fix, place).verdict).toBe("in_fence");
  });
  it("is in_fence when the uncertainty circle touches the fence", () => {
    const d = distanceMeters(place.lat, place.lng, 47.6576, place.lng);
    const r = checkinVerdict({ ...fix, lat: 47.6576, accuracyM: d - place.radiusM }, place);
    expect(r.verdict).toBe("in_fence");
  });
  it("is out_of_fence when the circle misses the fence", () => {
    expect(checkinVerdict({ ...fix, lat: 47.6596 }, place).verdict).toBe("out_of_fence");
  });
  it("is unjudgeable above 200 m accuracy", () => {
    expect(checkinVerdict({ ...fix, accuracyM: 200.01 }, place).verdict).toBe("unjudgeable");
  });
  it("accepts exactly 200 m accuracy", () => {
    expect(checkinVerdict({ ...fix, accuracyM: 200 }, place).verdict).toBe("in_fence");
  });
  it("is unjudgeable for null or negative accuracy", () => {
    expect(checkinVerdict({ ...fix, accuracyM: null }, place).verdict).toBe("unjudgeable");
    expect(checkinVerdict({ ...fix, accuracyM: -1 }, place).verdict).toBe("unjudgeable");
  });
  it("rejects simulated locations before anything else", () => {
    expect(checkinVerdict({ ...fix, isSimulated: true }, place).verdict).toBe("rejected_simulated");
  });
});

const deadline = "2026-11-09T17:00:00Z";
const ci = (userId: string, verdict: CheckinRecord["verdict"], server: string, client = server): CheckinRecord => ({
  userId,
  verdict,
  serverReceivedAt: server,
  clientCapturedAt: client,
});

describe("computeResults", () => {
  it("marks success from an in-fence check-in received by the deadline", () => {
    const r = computeResults({
      deadlineAt: deadline,
      participants: [
        { userId: "a", frozen: false },
        { userId: "b", frozen: false },
      ],
      checkins: [ci("a", "out_of_fence", "2026-11-09T16:10:00Z"), ci("a", "in_fence", "2026-11-09T16:20:00Z")],
    });
    expect(r.voided).toBe(false);
    expect(r.results).toEqual([
      { userId: "a", status: "success", firstSuccessAt: "2026-11-09T16:20:00Z" },
      { userId: "b", status: "failed", firstSuccessAt: null },
    ]);
  });

  it("does not count an in-fence check-in received after the deadline as success", () => {
    const r = computeResults({
      deadlineAt: deadline,
      participants: [
        { userId: "a", frozen: false },
        { userId: "b", frozen: false },
        { userId: "c", frozen: false },
      ],
      checkins: [
        ci("a", "in_fence", "2026-11-09T17:00:01Z", "2026-11-09T16:59:00Z"),
        ci("b", "in_fence", "2026-11-09T16:00:00Z"),
        ci("c", "in_fence", "2026-11-09T17:05:00Z", "2026-11-09T17:04:00Z"),
      ],
    });
    const byUser = Object.fromEntries(r.results.map((x) => [x.userId, x.status]));
    expect(byUser).toEqual({ a: "unverified", b: "success", c: "failed" });
  });

  it("makes a participant unverified when their only check-in was unjudgeable", () => {
    const r = computeResults({
      deadlineAt: deadline,
      participants: [
        { userId: "a", frozen: false },
        { userId: "b", frozen: false },
        { userId: "c", frozen: false },
      ],
      checkins: [ci("a", "unjudgeable", "2026-11-09T16:00:00Z"), ci("b", "in_fence", "2026-11-09T16:00:00Z")],
    });
    expect(r.results.map((x) => x.status)).toEqual(["unverified", "success", "failed"]);
  });

  it("counts simulated and out-of-fence check-ins as failed", () => {
    const r = computeResults({
      deadlineAt: deadline,
      participants: [
        { userId: "a", frozen: false },
        { userId: "b", frozen: false },
      ],
      checkins: [ci("a", "rejected_simulated", "2026-11-09T16:00:00Z"), ci("b", "out_of_fence", "2026-11-09T16:00:00Z")],
    });
    expect(r.results.map((x) => x.status)).toEqual(["failed", "failed"]);
  });

  it("marks frozen participants frozen regardless of check-ins", () => {
    const r = computeResults({
      deadlineAt: deadline,
      participants: [
        { userId: "a", frozen: true },
        { userId: "b", frozen: false },
        { userId: "c", frozen: false },
      ],
      checkins: [ci("a", "in_fence", "2026-11-09T16:00:00Z")],
    });
    expect(r.results.map((x) => x.status)).toEqual(["frozen", "failed", "failed"]);
  });

  it("voids the instance when fewer than two participants are active", () => {
    const r = computeResults({
      deadlineAt: deadline,
      participants: [
        { userId: "a", frozen: true },
        { userId: "b", frozen: false },
        { userId: "c", frozen: false },
      ],
      checkins: [ci("b", "in_fence", "2026-11-09T16:00:00Z"), ci("c", "unjudgeable", "2026-11-09T16:00:00Z")],
    });
    expect(r.voided).toBe(true);
    expect(r.results.map((x) => x.status)).toEqual(["frozen", "void", "void"]);
  });

  it("sorts results by user id", () => {
    const r = computeResults({
      deadlineAt: deadline,
      participants: [
        { userId: "z", frozen: false },
        { userId: "a", frozen: false },
      ],
      checkins: [],
    });
    expect(r.results.map((x) => x.userId)).toEqual(["a", "z"]);
  });
});

describe("computeInstancePayout", () => {
  const res = (userId: string, status: "success" | "failed" | "unverified" | "frozen" | "excluded", at: string | null = null) => ({
    userId,
    status,
    firstSuccessAt: status === "success" ? (at ?? "2026-11-09T16:00:00Z") : null,
  });

  it("moves nothing when everybody succeeded and there is no carry", () => {
    expect(computeInstancePayout({ stakeCents: 500, carryInCents: 0, results: [res("a", "success"), res("b", "success")] })).toEqual({
      memberDeltas: {},
      carryDelta: 0,
    });
  });

  it("moves failed stakes to winners", () => {
    expect(
      computeInstancePayout({
        stakeCents: 500,
        carryInCents: 0,
        results: [res("a", "success"), res("b", "failed"), res("c", "failed")],
      }),
    ).toEqual({ memberDeltas: { a: 1000, b: -500, c: -500 }, carryDelta: 0 });
  });

  it("gives leftover cents to the earliest check-ins first", () => {
    const out = computeInstancePayout({
      stakeCents: 100,
      carryInCents: 0,
      results: [
        res("a", "success", "2026-11-09T16:30:00Z"),
        res("b", "success", "2026-11-09T16:10:00Z"),
        res("c", "success", "2026-11-09T16:20:00Z"),
        res("d", "failed"),
      ],
    });
    expect(out.memberDeltas).toEqual({ a: 33, b: 34, c: 33, d: -100 });
  });

  it("breaks first-success ties by user id", () => {
    const out = computeInstancePayout({
      stakeCents: 1,
      carryInCents: 0,
      results: [res("b", "success", "2026-11-09T16:00:00Z"), res("a", "success", "2026-11-09T16:00:00Z"), res("x", "failed")],
    });
    expect(out.memberDeltas).toEqual({ a: 1, x: -1 });
  });

  it("rolls every failed stake into the carry when nobody succeeded", () => {
    expect(
      computeInstancePayout({ stakeCents: 500, carryInCents: 700, results: [res("a", "failed"), res("b", "failed")] }),
    ).toEqual({ memberDeltas: { a: -500, b: -500 }, carryDelta: 1000 });
  });

  it("pays the carry out to winners along with the pot", () => {
    expect(
      computeInstancePayout({
        stakeCents: 500,
        carryInCents: 1001,
        results: [res("a", "success", "2026-11-09T16:00:00Z"), res("b", "success", "2026-11-09T16:05:00Z"), res("c", "failed")],
      }),
    ).toEqual({ memberDeltas: { a: 751, b: 750, c: -500 }, carryDelta: -1001 });
  });

  it("ignores unverified, frozen and excluded participants", () => {
    expect(
      computeInstancePayout({
        stakeCents: 500,
        carryInCents: 0,
        results: [res("a", "success"), res("b", "unverified"), res("c", "frozen"), res("d", "excluded"), res("e", "failed")],
      }),
    ).toEqual({ memberDeltas: { a: 500, e: -500 }, carryDelta: 0 });
  });

  it("moves nothing when fewer than two participants are active", () => {
    expect(
      computeInstancePayout({ stakeCents: 500, carryInCents: 900, results: [res("a", "success"), res("b", "unverified")] }),
    ).toEqual({ memberDeltas: {}, carryDelta: 0 });
  });

  it("rejects invalid money inputs", () => {
    expect(() => computeInstancePayout({ stakeCents: 0, carryInCents: 0, results: [] })).toThrow(/stake/);
    expect(() => computeInstancePayout({ stakeCents: 1.5, carryInCents: 0, results: [] })).toThrow(/stake/);
    expect(() => computeInstancePayout({ stakeCents: 100, carryInCents: -1, results: [] })).toThrow(/carry/);
  });

  it("conserves money over many random instances", () => {
    const statuses = ["success", "failed", "unverified", "frozen", "excluded"] as const;
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 3000; i++) {
      const n = Math.floor(rand() * 9);
      const stake = 1 + Math.floor(rand() * 10000);
      const carry = rand() < 0.4 ? Math.floor(rand() * 50000) : 0;
      const results = Array.from({ length: n }, (_, k) =>
        res(`u${k}`, statuses[Math.floor(rand() * statuses.length)]!, `2026-11-09T16:${String(Math.floor(rand() * 60)).padStart(2, "0")}:00Z`),
      );
      const out = computeInstancePayout({ stakeCents: stake, carryInCents: carry, results });
      const total = Object.values(out.memberDeltas).reduce((a, b) => a + b, 0) + out.carryDelta;
      expect(total).toBe(0);
      for (const v of Object.values(out.memberDeltas)) {
        expect(Number.isSafeInteger(v)).toBe(true);
        expect(v).not.toBe(0);
      }
      expect(out.carryDelta).toBeGreaterThanOrEqual(-carry);
      const failed = results.filter((r) => r.status === "failed");
      const active = results.filter((r) => r.status === "success" || r.status === "failed");
      if (active.length >= 2) for (const f of failed) expect(out.memberDeltas[f.userId]).toBe(-stake);
    }
  });
});

describe("simplifyDebts", () => {
  it("returns nothing when everyone is even", () => {
    expect(simplifyDebts({ a: 0, b: 0 })).toEqual({ obligations: [], ridingInCarryCents: 0 });
  });

  it("pairs the largest debtor with the largest creditor", () => {
    expect(simplifyDebts({ a: 1000, b: -700, c: -300 })).toEqual({
      obligations: [
        { from: "b", to: "a", amountCents: 700 },
        { from: "c", to: "a", amountCents: 300 },
      ],
      ridingInCarryCents: 0,
    });
  });

  it("reports debt that is sitting in a carry as not yet payable", () => {
    expect(simplifyDebts({ a: 200, b: -500 })).toEqual({
      obligations: [{ from: "b", to: "a", amountCents: 200 }],
      ridingInCarryCents: 300,
    });
  });

  it("breaks ties by user id", () => {
    expect(simplifyDebts({ b: 100, a: 100, d: -100, c: -100 }).obligations).toEqual([
      { from: "c", to: "a", amountCents: 100 },
      { from: "d", to: "b", amountCents: 100 },
    ]);
  });

  it("never creates more obligations than members minus one and always pays every creditor", () => {
    let seed = 99;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 2000; i++) {
      const n = 2 + Math.floor(rand() * 7);
      const balances: Record<string, number> = {};
      let sum = 0;
      for (let k = 0; k < n - 1; k++) {
        const v = Math.floor(rand() * 4001) - 2000;
        balances[`u${k}`] = v;
        sum += v;
      }
      const carry = Math.floor(rand() * 1000);
      balances[`u${n - 1}`] = -sum - carry;
      const { obligations, ridingInCarryCents } = simplifyDebts(balances);
      expect(obligations.length).toBeLessThanOrEqual(n - 1);
      const net: Record<string, number> = { ...balances };
      for (const o of obligations) {
        expect(o.amountCents).toBeGreaterThan(0);
        net[o.from]! += o.amountCents;
        net[o.to]! -= o.amountCents;
      }
      for (const v of Object.values(net)) expect(v).toBeLessThanOrEqual(0);
      expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0 - ridingInCarryCents);
    }
  });

  it("rejects balances whose total is positive, which would mean money appeared from nowhere", () => {
    expect(() => simplifyDebts({ a: 100, b: -50 })).toThrow(/positive/);
  });
});
