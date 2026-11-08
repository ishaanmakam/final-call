import { describe, expect, it, vi } from "vitest";
import {
  bearerMatches,
  chunk,
  type ExpoTicket,
  formatCents,
  formatLocalTime,
  type OutboxRow,
  planMessages,
  processOutbox,
  renderNotification,
  resolveOutcomes,
  retryDelayMs,
  sendExpoBatch,
} from "../outbox.ts";

const NOW = new Date("2026-11-09T16:45:00Z");

function row(kind: string, payload: Record<string, unknown>, extra: Partial<OutboxRow> = {}): OutboxRow {
  return { id: 1, user_id: "u1", kind, payload, attempts: 1, ...extra };
}

const BANNED = /\b(bet|bets|stake|stakes|pot)\b/i;

describe("formatCents", () => {
  it("drops cents on whole dollars and keeps them otherwise", () => {
    expect(formatCents(500)).toBe("$5");
    expect(formatCents(250)).toBe("$2.50");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(123456)).toBe("$1,234.56");
  });
  it("formats the absolute value", () => {
    expect(formatCents(-750)).toBe("$7.50");
  });
});

describe("formatLocalTime", () => {
  it("formats a local time string, morning without suffix", () => {
    expect(formatLocalTime({ deadline_local: "09:00:00" })).toBe("9:00");
    expect(formatLocalTime({ deadline_local: "08:30" })).toBe("8:30");
  });
  it("adds PM for afternoon and handles noon/midnight", () => {
    expect(formatLocalTime({ deadline_local: "13:30:00" })).toBe("1:30 PM");
    expect(formatLocalTime({ deadline_local: "12:00" })).toBe("12:00 PM");
    expect(formatLocalTime({ deadline_local: "00:15" })).toBe("12:15");
  });
  it("converts a UTC instant into the pact zone", () => {
    expect(formatLocalTime({ deadline_at: "2026-11-09T17:00:00Z", tz: "America/Los_Angeles" })).toBe("9:00");
    expect(formatLocalTime({ deadline_at: "2026-07-09T16:00:00Z", tz: "America/Los_Angeles" })).toBe("9:00");
  });
  it("returns null when nothing usable is given", () => {
    expect(formatLocalTime({})).toBeNull();
    expect(formatLocalTime({ deadline_local: "garbage" })).toBeNull();
    expect(formatLocalTime({ deadline_at: "2026-11-09T17:00:00Z", tz: "Not/AZone" })).toBeNull();
  });
});

describe("renderNotification", () => {
  it("window_open names place, deadline, and pledge", () => {
    const r = renderNotification(
      row("window_open", {
        pact_title: "9am class",
        place_label: "Kane Hall",
        deadline_local: "09:00:00",
        stake_cents: 500,
        instance_id: "i1",
        pact_id: "p1",
        group_id: "g1",
      }),
      NOW,
    )!;
    expect(r.title).toBe("Check-in open: 9am class");
    expect(r.body).toBe("Kane Hall by 9:00. $5 pledge on the line.");
    expect(r.data).toEqual({ kind: "window_open", outbox_id: 1, instance_id: "i1", pact_id: "p1", group_id: "g1", url: "/checkin/i1" });
  });

  it("deadline_soon computes minutes left from deadline_at", () => {
    const r = renderNotification(
      row("deadline_soon", {
        pact_title: "9am class",
        place_label: "Kane Hall",
        deadline_at: "2026-11-09T17:00:00Z",
        tz: "America/Los_Angeles",
        stake_cents: 500,
      }),
      NOW,
    )!;
    expect(r.title).toBe("Kane Hall by 9:00 — 15 min left");
    expect(r.body).toBe("Check in now or forfeit your $5 pledge.");
  });

  it("deadline_soon falls back to minutes_left, then 15, and to the pact title without a place", () => {
    const a = renderNotification(row("deadline_soon", { pact_title: "Gym", deadline_local: "18:00", minutes_left: 10 }), NOW)!;
    expect(a.title).toBe("Gym by 6:00 PM — 10 min left");
    expect(a.body).toBe("Check in now.");
    const b = renderNotification(row("deadline_soon", { pact_title: "Gym" }), NOW)!;
    expect(b.title).toBe("Gym — 15 min left");
  });

  it("deadline_soon never shows zero or negative minutes", () => {
    const r = renderNotification(row("deadline_soon", { place_label: "Gym", deadline_at: "2026-11-09T16:40:00Z" }), NOW)!;
    expect(r.title).toMatch(/— 1 min left$/);
  });

  it("result success with winnings", () => {
    const r = renderNotification(row("result", { status: "success", pact_title: "9am class", net_cents: 250 }), NOW)!;
    expect(r.title).toBe("9am class: you made it");
    expect(r.body).toBe("You won $2.50 from the pool.");
  });

  it("result success without winnings", () => {
    const r = renderNotification(row("result", { status: "success", pact_title: "9am class", net_cents: 0 }), NOW)!;
    expect(r.body).toBe("Your pledge is safe.");
  });

  it("result failed, normal and rollover", () => {
    const a = renderNotification(row("result", { status: "failed", pact_title: "9am class", stake_cents: 500 }), NOW)!;
    expect(a.title).toBe("9am class: missed");
    expect(a.body).toBe("$5 pledge forfeited to the pool. Appeal before settlement if that's wrong.");
    const b = renderNotification(
      row("result", { status: "failed", pact_title: "9am class", stake_cents: 500, rolled_over: true }),
      NOW,
    )!;
    expect(b.body).toBe("$5 pledge forfeited. Nobody made it, so the pool rolls over.");
  });

  it("result unverified, frozen, void, excluded", () => {
    const t = (status: string) => renderNotification(row("result", { status, pact_title: "Gym" }), NOW)!;
    expect(t("unverified")).toMatchObject({ title: "Gym: couldn't verify", body: "No forfeit. Your check-in couldn't be judged." });
    expect(t("frozen")).toMatchObject({ title: "Gym: frozen", body: "No pledge today." });
    expect(t("void")).toMatchObject({ title: "Gym: void", body: "Fewer than 2 active, so no pledges today." });
    expect(t("excluded")).toMatchObject({ title: "Gym: excluded", body: "Your pledge was returned." });
  });

  it("result with an unknown status is not renderable", () => {
    expect(renderNotification(row("result", { status: "pending" }), NOW)).toBeNull();
  });

  it("review_opened appeal goes to voters", () => {
    const r = renderNotification(
      row("review_opened", {
        review_kind: "appeal",
        subject_user_id: "u2",
        subject_name: "Sam",
        opener_name: "Sam",
        pact_title: "9am class",
        review_id: "r1",
      }),
      NOW,
    )!;
    expect(r.title).toBe("Sam appealed a miss");
    expect(r.body).toBe("9am class: vote before settlement.");
    expect(r.data).toMatchObject({ review_id: "r1" });
  });

  it("review_opened challenge, to the subject and to other voters", () => {
    const payload = {
      review_kind: "challenge",
      subject_user_id: "u1",
      subject_name: "Ishaan",
      opener_name: "Priya",
      pact_title: "9am class",
    };
    const toSubject = renderNotification(row("review_opened", payload), NOW)!;
    expect(toSubject.title).toBe("Priya challenged your 9am class result");
    expect(toSubject.body).toBe("The group votes before settlement.");
    const toVoter = renderNotification(row("review_opened", payload, { user_id: "u3" }), NOW)!;
    expect(toVoter.title).toBe("Priya challenged Ishaan's check-in");
    expect(toVoter.body).toBe("9am class: vote before settlement.");
  });

  it("settlement owe / owed / square", () => {
    const t = (net_cents: number) =>
      renderNotification(row("settlement", { group_name: "Roommates", net_cents, settlement_id: "s1" }), NOW)!;
    expect(t(-750)).toMatchObject({ title: "Roommates: weekly settlement", body: "You owe $7.50. Tap for Venmo links." });
    expect(t(1200)).toMatchObject({ body: "You're owed $12. Your group will pay you on Venmo." });
    expect(t(0)).toMatchObject({ body: "You're square this week." });
    expect(t(0).data).toMatchObject({ kind: "settlement", settlement_id: "s1" });
  });

  it("uses fallbacks when names are missing and tolerates null payload", () => {
    expect(renderNotification(row("window_open", {}), NOW)!.title).toBe("Check-in open: your pact");
    expect(renderNotification({ ...row("settlement", {}), payload: null }, NOW)!.title).toBe("Your group: weekly settlement");
    expect(renderNotification(row("review_opened", { review_kind: "appeal" }), NOW)!.title).toBe("Someone appealed a miss");
  });

  it("returns null for unknown kinds", () => {
    expect(renderNotification(row("mystery", {}), NOW)).toBeNull();
  });

  it("never uses internal money wording in any copy", () => {
    const rows: OutboxRow[] = [
      row("window_open", { pact_title: "A", place_label: "B", deadline_local: "09:00", stake_cents: 500 }),
      row("deadline_soon", { pact_title: "A", place_label: "B", deadline_local: "09:00", stake_cents: 500 }),
      ...["success", "failed", "unverified", "frozen", "void", "excluded"].map((status) =>
        row("result", { status, pact_title: "A", stake_cents: 500, net_cents: 100 }),
      ),
      row("result", { status: "failed", pact_title: "A", stake_cents: 500, rolled_over: true }),
      row("review_opened", { review_kind: "appeal" }),
      row("review_opened", { review_kind: "challenge", subject_user_id: "u1" }),
      row("review_opened", { review_kind: "challenge", subject_user_id: "u2" }),
      ...[-100, 0, 100].map((net_cents) => row("settlement", { group_name: "G", net_cents })),
    ];
    for (const r of rows) {
      const out = renderNotification(r, NOW)!;
      expect(out, `${r.kind} ${JSON.stringify(r.payload)}`).not.toBeNull();
      expect(`${out.title} ${out.body}`).not.toMatch(BANNED);
    }
  });
});

describe("chunk", () => {
  it("splits into batches of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
    expect(chunk(Array.from({ length: 250 }, (_, i) => i), 100).map((b) => b.length)).toEqual([100, 100, 50]);
  });
});

describe("planMessages", () => {
  it("fans out one message per token and drops rows without tokens or with unknown kinds", () => {
    const rows: OutboxRow[] = [
      row("settlement", { group_name: "G", net_cents: 0 }, { id: 1, user_id: "u1" }),
      row("settlement", { group_name: "G", net_cents: 0 }, { id: 2, user_id: "u2" }),
      row("mystery", {}, { id: 3, user_id: "u1" }),
    ];
    const plan = planMessages(
      rows,
      [
        { user_id: "u1", token: "ExponentPushToken[a]" },
        { user_id: "u1", token: "ExponentPushToken[b]" },
      ],
      NOW,
    );
    expect(plan.messages.map((m) => [m.rowId, m.token])).toEqual([
      [1, "ExponentPushToken[a]"],
      [1, "ExponentPushToken[b]"],
    ]);
    expect(plan.messages[0].message).toMatchObject({
      to: "ExponentPushToken[a]",
      title: "G: weekly settlement",
      sound: "default",
      priority: "high",
    });
    expect(plan.drops).toEqual([
      { id: 2, error: "no push tokens" },
      { id: 3, error: "cannot render kind 'mystery'" },
    ]);
  });
});

describe("resolveOutcomes", () => {
  const planned = (rowId: number, userId: string, token: string) => ({
    rowId,
    userId,
    token,
    message: { to: token, title: "t", body: "b", data: {}, sound: "default" as const, priority: "high" as const },
  });
  const ok: ExpoTicket = { status: "ok", id: "x" };
  const dnr: ExpoTicket = {
    status: "error",
    message: "not registered",
    details: { error: "DeviceNotRegistered" },
  };
  const rate: ExpoTicket = { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } };

  it("a row is sent if any of its tokens got an ok ticket; dead tokens are collected", () => {
    const out = resolveOutcomes([planned(1, "u1", "A"), planned(1, "u1", "B")], [dnr, ok]);
    expect(out.sent).toEqual([1]);
    expect(out.retry).toEqual([]);
    expect(out.drop).toEqual([]);
    expect(out.deadTokens).toEqual([{ userId: "u1", token: "A" }]);
  });

  it("a row whose tokens are all unregistered is dropped, not retried", () => {
    const out = resolveOutcomes([planned(1, "u1", "A")], [dnr]);
    expect(out.sent).toEqual([]);
    expect(out.drop).toEqual([{ id: 1, error: "DeviceNotRegistered: all push tokens unregistered" }]);
    expect(out.deadTokens).toEqual([{ userId: "u1", token: "A" }]);
  });

  it("other errors are retried with the error code and message", () => {
    const out = resolveOutcomes([planned(1, "u1", "A"), planned(2, "u2", "C"), planned(2, "u2", "D")], [rate, dnr, rate]);
    expect(out.retry).toEqual([
      { id: 1, error: "MessageRateExceeded: slow down" },
      { id: 2, error: "MessageRateExceeded: slow down" },
    ]);
    expect(out.deadTokens).toEqual([{ userId: "u2", token: "C" }]);
  });

  it("a missing ticket counts as a retryable error", () => {
    const out = resolveOutcomes([planned(1, "u1", "A")], []);
    expect(out.retry).toEqual([{ id: 1, error: "missing push ticket" }]);
  });
});

describe("sendExpoBatch", () => {
  const msg = { to: "ExponentPushToken[a]", title: "t", body: "b", data: {}, sound: "default" as const, priority: "high" as const };

  it("posts JSON to the Expo API with the access token and returns tickets", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: "ok", id: "abc" }] }), { status: 200 }));
    const tickets = await sendExpoBatch(fetchFn, [msg], { accessToken: "tok" });
    expect(tickets).toEqual([{ status: "ok", id: "abc" }]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual([msg]);
  });

  it("omits Authorization without an access token", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: "ok", id: "abc" }] })));
    await sendExpoBatch(fetchFn, [msg], {});
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("turns HTTP errors, request-level errors, and network failures into error tickets for every message", async () => {
    const http = await sendExpoBatch(async () => new Response("boom", { status: 500 }), [msg, msg], {});
    expect(http).toHaveLength(2);
    expect(http[0]).toMatchObject({ status: "error", message: "HTTP 500: boom" });

    const reqErr = await sendExpoBatch(
      async () => new Response(JSON.stringify({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: "mixed" }] })),
      [msg],
      {},
    );
    expect(reqErr[0]).toMatchObject({ status: "error", message: "PUSH_TOO_MANY_EXPERIENCE_IDS: mixed" });

    const net = await sendExpoBatch(async () => {
      throw new Error("ECONNRESET");
    }, [msg], {});
    expect(net[0]).toMatchObject({ status: "error", message: "network: ECONNRESET" });
  });

  it("does not call fetch for an empty batch", async () => {
    const fetchFn = vi.fn();
    expect(await sendExpoBatch(fetchFn, [], {})).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("processOutbox", () => {
  function makeDeps(rows: OutboxRow[], tokens: { user_id: string; token: string }[], send: (n: number) => ExpoTicket[]) {
    const calls = {
      batches: [] as number[],
      sent: [] as number[],
      failed: [] as { id: number; error: string }[],
      dropped: [] as { id: number; error: string }[],
      deleted: [] as { userId: string; token: string }[],
      claimLimit: 0,
      tokenUsers: [] as string[],
    };
    const deps = {
      now: () => NOW,
      claim: async (limit: number) => {
        calls.claimLimit = limit;
        return rows;
      },
      tokensFor: async (userIds: string[]) => {
        calls.tokenUsers = userIds;
        return tokens.filter((t) => userIds.includes(t.user_id));
      },
      send: async (messages: unknown[]) => {
        calls.batches.push(messages.length);
        return send(messages.length);
      },
      markSent: async (ids: number[]) => void calls.sent.push(...ids),
      markFailed: async (f: { id: number; error: string }[]) => void calls.failed.push(...f),
      markDropped: async (d: { id: number; error: string }[]) => void calls.dropped.push(...d),
      deleteTokens: async (t: { userId: string; token: string }[]) => void calls.deleted.push(...t),
    };
    return { deps, calls };
  }

  it("does nothing when there is nothing to claim", async () => {
    const { deps, calls } = makeDeps([], [], () => []);
    const summary = await processOutbox(deps);
    expect(summary).toEqual({ claimed: 0, sent: 0, retried: 0, dropped: 0, tokensDeleted: 0 });
    expect(calls.claimLimit).toBe(100);
    expect(calls.batches).toEqual([]);
  });

  it("claims, batches by 100, marks outcomes, and deletes dead tokens", async () => {
    const rows: OutboxRow[] = Array.from({ length: 60 }, (_, i) => row("settlement", { group_name: "G", net_cents: 0 }, { id: i + 1, user_id: `u${i % 30}` }));
    rows.push(row("settlement", { group_name: "G" }, { id: 61, user_id: "nobody" }));
    const tokens = Array.from({ length: 30 }, (_, i) => [
      { user_id: `u${i}`, token: `T${i}a` },
      { user_id: `u${i}`, token: `T${i}b` },
    ]).flat();
    let call = 0;
    const { deps, calls } = makeDeps(rows, tokens, (n) => {
      call++;
      return Array.from({ length: n }, (_, j) =>
        call === 1 && j === 0
          ? ({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } as ExpoTicket)
          : ({ status: "ok", id: `${call}-${j}` } as ExpoTicket),
      );
    });
    const summary = await processOutbox(deps);
    expect(calls.batches).toEqual([100, 20]);
    expect(new Set(calls.tokenUsers)).toEqual(new Set([...Array.from({ length: 30 }, (_, i) => `u${i}`), "nobody"]));
    expect(calls.tokenUsers.length).toBe(31);
    expect(calls.sent.sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(calls.dropped).toEqual([{ id: 61, error: "no push tokens" }]);
    expect(calls.deleted).toEqual([{ userId: "u0", token: "T0a" }]);
    expect(summary).toEqual({ claimed: 61, sent: 60, retried: 0, dropped: 1, tokensDeleted: 1 });
  });

  it("records retryable failures", async () => {
    const { deps, calls } = makeDeps(
      [row("settlement", { net_cents: 0 }, { id: 9 })],
      [{ user_id: "u1", token: "A" }],
      () => [{ status: "error", message: "HTTP 503: down" }],
    );
    const summary = await processOutbox(deps);
    expect(calls.failed).toEqual([{ id: 9, error: "HTTP 503: down", retryAt: "2026-11-09T16:46:00.000Z" }]);
    expect(calls.sent).toEqual([]);
    expect(summary.retried).toBe(1);
  });

  it("dedupes dead tokens across rows", async () => {
    const { deps, calls } = makeDeps(
      [row("settlement", {}, { id: 1 }), row("settlement", {}, { id: 2 })],
      [{ user_id: "u1", token: "A" }],
      (n) => Array.from({ length: n }, () => ({ status: "error", message: "x", details: { error: "DeviceNotRegistered" } }) as ExpoTicket),
    );
    await processOutbox(deps);
    expect(calls.deleted).toEqual([{ userId: "u1", token: "A" }]);
    expect(calls.dropped.map((d) => d.id)).toEqual([1, 2]);
  });
});

describe("bearerMatches", () => {
  it("accepts only an exact Bearer match", () => {
    expect(bearerMatches("Bearer secret-key", "secret-key")).toBe(true);
    expect(bearerMatches("bearer secret-key", "secret-key")).toBe(true);
    expect(bearerMatches("Bearer secret-kez", "secret-key")).toBe(false);
    expect(bearerMatches("Bearer secret", "secret-key")).toBe(false);
    expect(bearerMatches("secret-key", "secret-key")).toBe(false);
    expect(bearerMatches(null, "secret-key")).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});

// ---------- review fixes (docs/REVIEW.md F1-F4) ----------

describe("deep-link url in push data (F1)", () => {
  const base = { instance_id: "i1", pact_id: "p1", group_id: "g1" };
  it("window_open and deadline_soon open the check-in screen", () => {
    expect(renderNotification(row("window_open", { ...base, pact_title: "A" }), NOW)!.data.url).toBe("/checkin/i1");
    expect(renderNotification(row("deadline_soon", { ...base, pact_title: "A", deadline_at: "2026-11-09T17:00:00Z" }), NOW)!.data.url).toBe("/checkin/i1");
  });
  it("result and review_opened open the group feed, settlement opens the ledger", () => {
    expect(renderNotification(row("result", { ...base, status: "success" }), NOW)!.data.url).toBe("/groups/g1/feed");
    expect(renderNotification(row("review_opened", { ...base, review_kind: "appeal" }), NOW)!.data.url).toBe("/groups/g1/feed");
    expect(renderNotification(row("settlement", { group_id: "g1", net_cents: 0 }), NOW)!.data.url).toBe("/groups/g1/ledger");
  });
  it("omits url when the ids it needs are missing", () => {
    expect(renderNotification(row("settlement", { net_cents: 0 }), NOW)!.data.url).toBeUndefined();
    expect(renderNotification(row("window_open", { pact_title: "A" }), NOW)!.data.url).toBeUndefined();
  });
});

describe("stale reminders are dropped, not sent late (F2)", () => {
  it("window_open / deadline_soon whose deadline has passed are dropped", () => {
    const rows: OutboxRow[] = [
      row("deadline_soon", { pact_title: "A", deadline_at: "2026-11-09T16:30:00Z" }, { id: 1 }),
      row("window_open", { pact_title: "A", deadline_at: "2026-11-09T16:00:00Z" }, { id: 2 }),
      row("deadline_soon", { pact_title: "A", deadline_at: "2026-11-09T17:00:00Z" }, { id: 3 }),
      row("result", { status: "success", deadline_at: "2026-11-09T16:00:00Z" }, { id: 4 }),
    ];
    const plan = planMessages(rows, [{ user_id: "u1", token: "T" }], NOW);
    expect(plan.drops).toEqual([
      { id: 1, error: "stale: deadline passed" },
      { id: 2, error: "stale: deadline passed" },
    ]);
    expect(plan.messages.map((m) => m.rowId)).toEqual([3, 4]);
  });
});

describe("retry backoff (F3)", () => {
  it("backs off by attempt count: 1, 5, 15, 60 minutes", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(9)).toBe(3_600_000);
  });

  it("processOutbox stamps each retried row with retryAt derived from its attempts", async () => {
    const failed: { id: number; error: string; retryAt?: string }[] = [];
    const deps = {
      now: () => NOW,
      claim: async () => [row("settlement", { net_cents: 0 }, { id: 1, attempts: 1 }), row("settlement", { net_cents: 0 }, { id: 2, attempts: 3 })],
      tokensFor: async () => [{ user_id: "u1", token: "A" }],
      send: async (m: unknown[]) => m.map(() => ({ status: "error", message: "HTTP 503: down" }) as ExpoTicket),
      markSent: async () => {},
      markFailed: async (f: { id: number; error: string; retryAt?: string }[]) => void failed.push(...f),
      markDropped: async () => {},
      deleteTokens: async () => {},
    };
    await processOutbox(deps);
    expect(failed).toEqual([
      { id: 1, error: "HTTP 503: down", retryAt: "2026-11-09T16:46:00.000Z" },
      { id: 2, error: "HTTP 503: down", retryAt: "2026-11-09T17:00:00.000Z" },
    ]);
  });
});
