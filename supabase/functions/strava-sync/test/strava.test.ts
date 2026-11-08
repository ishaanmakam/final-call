import { describe, expect, it, vi } from "vitest";
import {
  activityTypeFor,
  allowedRedirect,
  authorizeUrl,
  backfill,
  backfillAfterEpoch,
  base64UrlDecode,
  base64UrlEncode,
  bearerToken,
  type Deps,
  ensureSubscription,
  exchangeCode,
  hasRequiredScope,
  isExpiring,
  mapActivity,
  nearLimit,
  nextQuarterHour,
  nextUtcMidnight,
  parseOrigins,
  parseRateLimit,
  parseWebhookEvent,
  processEvent,
  refreshAccessToken,
  returnUrl,
  routeOf,
  signState,
  type StoredToken,
  type StravaActivity,
  StravaRateLimited,
  stravaJson,
  timingSafeEqual,
  TokenRevoked,
  verifyState,
  webhookChallenge,
  withFreshToken,
} from "../strava.ts";

const NOW = new Date("2026-11-08T17:20:00Z");
const SECRET = "test-state-secret";
const USER = "6f1b7f6e-5c2a-4d3b-9e8f-0a1b2c3d4e5f";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

/** A fake fetch keyed by `METHOD url-prefix`; the first matching entry answers, in order. */
function fakeFetch(routes: [matcher: RegExp | string, handler: (url: string, init?: RequestInit) => Response | Promise<Response>][]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    for (const [m, h] of routes) {
      if (typeof m === "string" ? key.startsWith(m) : m.test(key)) return h(url, init);
    }
    return new Response("not routed: " + key, { status: 599 });
  });
}

const run: StravaActivity = {
  id: 1234567890,
  sport_type: "Run",
  type: "Run",
  start_date: "2026-11-07T15:00:00Z",
  elapsed_time: 2500,
  moving_time: 2400,
  distance: 8012.3,
  device_name: "Garmin Forerunner 255",
  manual: false,
  trainer: false,
};

function token(over: Partial<StoredToken> = {}): StoredToken {
  return {
    user_id: USER,
    athlete_id: "4242",
    access_token: "access-old",
    refresh_token: "refresh-old",
    expires_at: "2026-11-08T23:00:00Z",
    ...over,
  };
}

function deps(fetch: Deps["fetch"], over: Partial<Deps> = {}): Deps & { saved: StoredToken[]; deleted: string[]; submitted: { userId: string; items: unknown[] }[] } {
  const saved: StoredToken[] = [];
  const deleted: string[] = [];
  const submitted: { userId: string; items: unknown[] }[] = [];
  return {
    fetch,
    now: () => NOW,
    clientId: "cid",
    clientSecret: "csecret",
    tokenForAthlete: async (id) => (id === "4242" ? token() : null),
    saveToken: async (t) => {
      saved.push(t);
    },
    deleteTokenForAthlete: async (id) => {
      deleted.push(id);
    },
    submitActivities: async (userId, items) => {
      submitted.push({ userId, items });
      return items.length;
    },
    saved,
    deleted,
    submitted,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------

describe("base64url and constant-time compare", () => {
  it("round-trips bytes without padding characters", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = base64UrlEncode(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect([...base64UrlDecode(text)!]).toEqual([...bytes]);
  });
  it("rejects non-base64url input", () => {
    expect(base64UrlDecode("a+b/c=")).toBeNull();
  });
  it("timingSafeEqual compares whole strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("signed state", () => {
  it("signs and verifies a user id with an expiry", async () => {
    const state = await signState(SECRET, { u: USER, e: Math.floor(NOW.getTime() / 1000) + 600 });
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyState(SECRET, state, NOW)).toEqual({ u: USER, e: Math.floor(NOW.getTime() / 1000) + 600 });
  });
  it("carries the redirect through", async () => {
    const state = await signState(SECRET, { u: USER, e: Math.floor(NOW.getTime() / 1000) + 600, r: "https://ishaanmakam.github.io/final-call/app/settings" });
    expect((await verifyState(SECRET, state, NOW))?.r).toBe("https://ishaanmakam.github.io/final-call/app/settings");
  });
  it("rejects a tampered payload, a wrong secret, an expired state and garbage", async () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 600;
    const state = await signState(SECRET, { u: USER, e: exp });
    const [body, mac] = state.split(".") as [string, string];
    const other = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ u: "00000000-0000-0000-0000-000000000000", e: exp })));
    expect(await verifyState(SECRET, `${other}.${mac}`, NOW)).toBeNull();
    expect(await verifyState("another-secret", state, NOW)).toBeNull();
    expect(await verifyState(SECRET, state, new Date(exp * 1000))).toBeNull();
    expect(await verifyState(SECRET, state, new Date(exp * 1000 + 1))).toBeNull();
    expect(await verifyState(SECRET, body, NOW)).toBeNull();
    expect(await verifyState(SECRET, "", NOW)).toBeNull();
    expect(await verifyState(SECRET, null, NOW)).toBeNull();
    expect(await verifyState(SECRET, "nota.state", NOW)).toBeNull();
    expect(await verifyState("", state, NOW)).toBeNull();
  });
  it("red team: a state signed for one user cannot be re-pointed at another, and the TTL bounds a replay", async () => {
    const mine = await signState(SECRET, { u: USER, e: Math.floor(NOW.getTime() / 1000) + 900 });
    const [body, mac] = mine.split(".") as [string, string];
    const other = "00000000-0000-4000-8000-000000000001";
    const swapped = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ u: other, e: Math.floor(NOW.getTime() / 1000) + 900 })));
    expect(await verifyState(SECRET, `${swapped}.${mac}`, NOW)).toBeNull();
    expect(await verifyState(SECRET, `${body}.${mac}`, new Date(NOW.getTime() + 899_000))).toMatchObject({ u: USER });
    expect(await verifyState(SECRET, `${body}.${mac}`, new Date(NOW.getTime() + 900_000))).toBeNull();
  });

  it("rejects a payload whose user id is not a uuid", async () => {
    const state = await signState(SECRET, { u: "not-a-uuid", e: Math.floor(NOW.getTime() / 1000) + 600 });
    expect(await verifyState(SECRET, state, NOW)).toBeNull();
  });
  it("refuses to sign without a secret", async () => {
    await expect(signState("", { u: USER, e: 1 })).rejects.toThrow(/STRAVA_STATE_SECRET/);
  });
});

describe("redirect allow-list and return URLs", () => {
  const opts = { appScheme: "finalcall", webOrigins: parseOrigins("https://ishaanmakam.github.io, http://localhost:8081") };
  it("accepts the app scheme and the listed web origins only", () => {
    expect(allowedRedirect("finalcall://settings", opts)).toBe("finalcall://settings");
    expect(allowedRedirect("https://ishaanmakam.github.io/final-call/app/settings", opts)).toBe("https://ishaanmakam.github.io/final-call/app/settings");
    expect(allowedRedirect("http://localhost:8081/settings", opts)).toBe("http://localhost:8081/settings");
    expect(allowedRedirect("https://evil.example/settings", opts)).toBeNull();
    expect(allowedRedirect("https://ishaanmakam.github.io.evil.example/x", opts)).toBeNull();
    expect(allowedRedirect("javascript:alert(1)", opts)).toBeNull();
    expect(allowedRedirect("not a url", opts)).toBeNull();
    expect(allowedRedirect(null, opts)).toBeNull();
    expect(allowedRedirect("", opts)).toBeNull();
  });
  it("parseOrigins defaults to the Pages origin and drops junk", () => {
    expect(parseOrigins(undefined)).toEqual(["https://ishaanmakam.github.io"]);
    expect(parseOrigins("https://a.example/path, junk, https://b.example:8443")).toEqual(["https://a.example", "https://b.example:8443"]);
  });
  it("returnUrl appends strava=connected / strava=error&reason", () => {
    expect(returnUrl("finalcall://settings", "connected")).toBe("finalcall://settings?strava=connected");
    expect(returnUrl("https://ishaanmakam.github.io/final-call/app/settings?tab=x", "error", "access_denied")).toBe(
      "https://ishaanmakam.github.io/final-call/app/settings?tab=x&strava=error&reason=access_denied",
    );
    expect(returnUrl("finalcall://settings?strava=error&reason=x", "connected")).toBe("finalcall://settings?strava=connected");
  });
});

describe("authorize URL and scope", () => {
  it("points at Strava with code flow, read_all scope, our callback and the state", () => {
    const url = new URL(authorizeUrl({ clientId: "123", redirectUri: "https://ref.supabase.co/functions/v1/strava-sync/callback", state: "s.t" }));
    expect(url.origin + url.pathname).toBe("https://www.strava.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://ref.supabase.co/functions/v1/strava-sync/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("activity:read_all");
    expect(url.searchParams.get("approval_prompt")).toBe("auto");
    expect(url.searchParams.get("state")).toBe("s.t");
  });
  it("hasRequiredScope needs activity:read_all in Strava's comma list", () => {
    expect(hasRequiredScope("read,activity:read_all")).toBe(true);
    expect(hasRequiredScope("read,activity:read")).toBe(false);
    expect(hasRequiredScope(null)).toBe(false);
  });
});

describe("webhook verify handshake", () => {
  it("echoes hub.challenge when the verify token matches", () => {
    const p = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "abc123" });
    expect(webhookChallenge(p, "vt")).toEqual({ "hub.challenge": "abc123" });
  });
  it("refuses a wrong token, a missing challenge, another mode, and an unset token", () => {
    expect(webhookChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "no", "hub.challenge": "x" }), "vt")).toBeNull();
    expect(webhookChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "vt" }), "vt")).toBeNull();
    expect(webhookChallenge(new URLSearchParams({ "hub.mode": "unsubscribe", "hub.verify_token": "vt", "hub.challenge": "x" }), "vt")).toBeNull();
    expect(webhookChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "x" }), "")).toBeNull();
  });
});

describe("activity mapping", () => {
  it("maps sport types to the contract activity types, else other", () => {
    expect(activityTypeFor("Run")).toBe("running");
    expect(activityTypeFor("TrailRun")).toBe("running");
    expect(activityTypeFor("Walk")).toBe("walking");
    expect(activityTypeFor("Ride")).toBe("cycling");
    expect(activityTypeFor("VirtualRide")).toBe("cycling");
    expect(activityTypeFor("Swim")).toBe("swimming");
    expect(activityTypeFor("Hike")).toBe("hiking");
    expect(activityTypeFor("Rowing")).toBe("rowing");
    expect(activityTypeFor("WeightTraining")).toBe("strength");
    expect(activityTypeFor("Yoga")).toBe("yoga");
    expect(activityTypeFor("EBikeRide")).toBe("other");
    expect(activityTypeFor("AlpineSki")).toBe("other");
    expect(activityTypeFor(null, "Run")).toBe("running");
    expect(activityTypeFor(undefined, undefined)).toBe("other");
  });

  it("builds a submit item: ended_at = start + elapsed, duration = moving, device, manual flag, hash", async () => {
    const item = (await mapActivity(run))!;
    expect(item).toMatchObject({
      source: "strava",
      external_id: "1234567890",
      activity_type: "running",
      started_at: "2026-11-07T15:00:00.000Z",
      ended_at: "2026-11-07T15:41:40.000Z",
      distance_m: 8012.3,
      duration_s: 2400,
      steps: null,
      device: "Garmin Forerunner 255",
      app_bundle: null,
      is_manual: false,
    });
    expect(item.raw_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the hash is stable for the same activity and changes when a field changes", async () => {
    const a = (await mapActivity(run))!;
    const b = (await mapActivity({ ...run, name: "renamed" }))!; // name is not a mapped field
    const c = (await mapActivity({ ...run, distance: 8100 }))!;
    expect(a.raw_hash).toBe(b.raw_hash);
    expect(a.raw_hash).not.toBe(c.raw_hash);
  });

  it("manual entries are flagged; trainer rides are not", async () => {
    expect((await mapActivity({ ...run, manual: true }))!.is_manual).toBe(true);
    expect((await mapActivity({ ...run, sport_type: "VirtualRide", trainer: true }))!).toMatchObject({ activity_type: "cycling", is_manual: false });
  });

  it("handles missing moving_time, zero distance and a missing device", async () => {
    const item = (await mapActivity({ id: 7, sport_type: "WeightTraining", start_date: "2026-11-07T15:00:00Z", elapsed_time: 1800, distance: 0 }))!;
    expect(item).toMatchObject({ activity_type: "strength", duration_s: 1800, distance_m: null, device: null, is_manual: false });
  });

  it("returns null for an unusable activity", async () => {
    expect(await mapActivity({ id: 1, start_date: "garbage", elapsed_time: 10 })).toBeNull();
    expect(await mapActivity({ id: Number.NaN, start_date: "2026-11-07T15:00:00Z", elapsed_time: 10 })).toBeNull();
  });
});

describe("rate limits", () => {
  it("parses X-RateLimit headers and prefers the read limits", () => {
    expect(parseRateLimit(new Headers({ "X-RateLimit-Limit": "200,2000", "X-RateLimit-Usage": "17,320" }))).toEqual({ limit15: 200, limitDay: 2000, usage15: 17, usageDay: 320 });
    expect(
      parseRateLimit(new Headers({ "X-RateLimit-Limit": "200,2000", "X-RateLimit-Usage": "17,320", "X-ReadRateLimit-Limit": "100,1000", "X-ReadRateLimit-Usage": "99,1" })),
    ).toEqual({ limit15: 100, limitDay: 1000, usage15: 99, usageDay: 1 });
    expect(parseRateLimit(new Headers({}))).toBeNull();
    expect(parseRateLimit(new Headers({ "X-RateLimit-Limit": "junk", "X-RateLimit-Usage": "1,2" }))).toBeNull();
  });
  it("nearLimit leaves one request of headroom in either window", () => {
    expect(nearLimit({ limit15: 100, limitDay: 1000, usage15: 98, usageDay: 10 })).toBe(false);
    expect(nearLimit({ limit15: 100, limitDay: 1000, usage15: 99, usageDay: 10 })).toBe(true);
    expect(nearLimit({ limit15: 100, limitDay: 1000, usage15: 1, usageDay: 999 })).toBe(true);
    expect(nearLimit(null)).toBe(false);
  });
  it("window boundaries", () => {
    expect(nextQuarterHour(new Date("2026-11-08T17:20:00Z")).toISOString()).toBe("2026-11-08T17:30:00.000Z");
    expect(nextQuarterHour(new Date("2026-11-08T17:30:00Z")).toISOString()).toBe("2026-11-08T17:45:00.000Z");
    expect(nextUtcMidnight(new Date("2026-11-08T17:20:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
  it("stravaJson throws StravaRateLimited on 429 with the next quarter hour", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/", () => new Response("Rate Limit Exceeded", { status: 429, headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "101,50" } })]]);
    const err = await stravaJson(fetch, "https://www.strava.com/api/v3/activities/1", { method: "GET" }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(StravaRateLimited);
    expect((err as StravaRateLimited).retryAt.toISOString()).toBe("2026-11-08T17:30:00.000Z");
  });
  it("a daily limit sends the retry to UTC midnight", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/", () => new Response("", { status: 429, headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "5,1000" } })]]);
    const err = (await stravaJson(fetch, "https://www.strava.com/api/v3/x", { method: "GET" }, NOW).catch((e) => e)) as StravaRateLimited;
    expect(err.retryAt.toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
  it("stravaJson returns status, parsed body and the limits otherwise", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/", () => jsonResponse({ id: 1 }, { headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "2,3" } })]]);
    const r = await stravaJson<{ id: number }>(fetch, "https://www.strava.com/api/v3/x", { method: "GET" }, NOW);
    expect(r).toMatchObject({ status: 200, body: { id: 1 }, rateLimit: { usage15: 2 } });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("OAuth token calls", () => {
  it("exchangeCode posts the code as a form and returns tokens with the athlete", async () => {
    const fetch = fakeFetch([
      ["POST https://www.strava.com/oauth/token", (_, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("cid");
        expect(body.get("client_secret")).toBe("csecret");
        expect(body.get("code")).toBe("thecode");
        expect(body.get("grant_type")).toBe("authorization_code");
        return jsonResponse({ access_token: "a", refresh_token: "r", expires_at: 1_800_000_000, athlete: { id: 4242, firstname: "Ish" } });
      }],
    ]);
    const t = await exchangeCode(fetch, { clientId: "cid", clientSecret: "csecret" }, "thecode", NOW);
    expect(t).toMatchObject({ access_token: "a", refresh_token: "r", expires_at: 1_800_000_000, athlete: { id: 4242 } });
  });
  it("exchangeCode fails loudly on a bad response", async () => {
    const fetch = fakeFetch([["POST https://www.strava.com/oauth/token", () => jsonResponse({ message: "Bad Request" }, { status: 400 })]]);
    await expect(exchangeCode(fetch, { clientId: "cid", clientSecret: "csecret" }, "x", NOW)).rejects.toThrow(/token exchange failed: HTTP 400/);
  });
  it("refreshAccessToken posts the refresh token; 400/401 means revoked", async () => {
    const ok = fakeFetch([["POST https://www.strava.com/oauth/token", (_, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-old");
      return jsonResponse({ access_token: "a2", refresh_token: "r2", expires_at: 1_800_000_000 });
    }]]);
    expect(await refreshAccessToken(ok, { clientId: "cid", clientSecret: "csecret" }, "refresh-old", NOW)).toMatchObject({ access_token: "a2" });
    const revoked = fakeFetch([["POST https://www.strava.com/oauth/token", () => jsonResponse({ message: "Bad Request", errors: [{ field: "refresh_token", code: "invalid" }] }, { status: 400 })]]);
    await expect(refreshAccessToken(revoked, { clientId: "cid", clientSecret: "csecret" }, "refresh-old", NOW)).rejects.toBeInstanceOf(TokenRevoked);
  });
});

describe("withFreshToken", () => {
  it("uses the stored token when it is fresh", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/api/v3/activities/1", (_, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-old");
      return jsonResponse({ ...run, id: 1 });
    }]]);
    const d = deps(fetch);
    const { response, token: t } = await withFreshToken(d, token(), (a) => stravaJson(d.fetch, "https://www.strava.com/api/v3/activities/1", { headers: { authorization: `Bearer ${a}` } }, NOW));
    expect(response.status).toBe(200);
    expect(t.access_token).toBe("access-old");
    expect(d.saved).toEqual([]);
  });
  it("refreshes first when the token expires within a minute, and saves the new one", async () => {
    const fetch = fakeFetch([
      ["POST https://www.strava.com/oauth/token", () => jsonResponse({ access_token: "access-new", refresh_token: "refresh-new", expires_at: Math.floor(NOW.getTime() / 1000) + 6 * 3600 })],
      ["GET https://www.strava.com/api/v3/activities/1", (_, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-new");
        return jsonResponse({ ...run, id: 1 });
      }],
    ]);
    const d = deps(fetch);
    expect(isExpiring(token({ expires_at: new Date(NOW.getTime() + 30_000).toISOString() }), NOW)).toBe(true);
    const { token: t } = await withFreshToken(d, token({ expires_at: new Date(NOW.getTime() + 30_000).toISOString() }), (a) =>
      stravaJson(d.fetch, "https://www.strava.com/api/v3/activities/1", { headers: { authorization: `Bearer ${a}` } }, NOW),
    );
    expect(t).toMatchObject({ access_token: "access-new", refresh_token: "refresh-new", user_id: USER, athlete_id: "4242" });
    expect(t.expires_at).toBe(new Date(NOW.getTime() + 6 * 3600_000).toISOString());
    expect(d.saved).toHaveLength(1);
  });
  it("retries once after a 401 with a refreshed token", async () => {
    let calls = 0;
    const fetch = fakeFetch([
      ["POST https://www.strava.com/oauth/token", () => jsonResponse({ access_token: "access-new", refresh_token: "refresh-new", expires_at: 1_800_000_000 })],
      ["GET https://www.strava.com/api/v3/activities/1", (_, init) => {
        calls++;
        const auth = new Headers(init?.headers).get("authorization");
        return auth === "Bearer access-new" ? jsonResponse({ ...run, id: 1 }) : jsonResponse({ message: "Authorization Error" }, { status: 401 });
      }],
    ]);
    const d = deps(fetch);
    const { response } = await withFreshToken(d, token(), (a) => stravaJson(d.fetch, "https://www.strava.com/api/v3/activities/1", { headers: { authorization: `Bearer ${a}` } }, NOW));
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(d.saved[0]?.access_token).toBe("access-new");
  });
  it("a refused refresh deletes the stored token and throws TokenRevoked", async () => {
    const fetch = fakeFetch([
      ["POST https://www.strava.com/oauth/token", () => jsonResponse({ message: "Bad Request" }, { status: 400 })],
      ["GET https://www.strava.com/api/v3/activities/1", () => jsonResponse({ message: "Authorization Error" }, { status: 401 })],
    ]);
    const d = deps(fetch);
    await expect(withFreshToken(d, token(), (a) => stravaJson(d.fetch, "https://www.strava.com/api/v3/activities/1", { headers: { authorization: `Bearer ${a}` } }, NOW))).rejects.toBeInstanceOf(TokenRevoked);
    expect(d.deleted).toEqual(["4242"]);
  });
});

describe("processEvent", () => {
  const createEvent = { object_type: "activity", object_id: 1234567890, aspect_type: "create", owner_id: 4242, subscription_id: 1, event_time: 1_762_600_000 };

  it("parseWebhookEvent accepts Strava's shape and rejects junk", () => {
    expect(parseWebhookEvent(createEvent)).toEqual(createEvent);
    expect(parseWebhookEvent({ ...createEvent, updates: { title: "x" } })?.updates).toEqual({ title: "x" });
    expect(parseWebhookEvent({ object_type: "activity" })).toBeNull();
    expect(parseWebhookEvent(null)).toBeNull();
    expect(parseWebhookEvent("str")).toBeNull();
  });

  it("activity create: fetches the activity with the owner's token and submits one mapped item", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/api/v3/activities/1234567890", (_, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-old");
      return jsonResponse(run);
    }]]);
    const d = deps(fetch);
    expect(await processEvent(d, createEvent)).toEqual({ ok: true, action: "submitted", submitted: 1 });
    expect(d.submitted).toHaveLength(1);
    expect(d.submitted[0]!.userId).toBe(USER);
    expect(d.submitted[0]!.items[0]).toMatchObject({ source: "strava", external_id: "1234567890", activity_type: "running", is_manual: false });
  });

  it("activity update: same path (the server decides what a changed hash means)", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/api/v3/activities/", () => jsonResponse({ ...run, manual: true })]]);
    const d = deps(fetch);
    expect(await processEvent(d, { ...createEvent, aspect_type: "update", updates: { type: "Run" } })).toEqual({ ok: true, action: "submitted", submitted: 1 });
    expect(d.submitted[0]!.items[0]).toMatchObject({ is_manual: true });
  });

  it("red team: a forged event for a known athlete can only re-deliver that athlete's own activity; nothing from the body is stored", async () => {
    // the sender claims object 999 is a 50 km run; Strava (the only source we read) says it is the athlete's real 8 km
    const fetch = fakeFetch([["GET https://www.strava.com/api/v3/activities/999", () => jsonResponse({ ...run, id: 999 })]]);
    const d = deps(fetch);
    const forged = { ...createEvent, object_id: 999, updates: { distance: "50000", type: "Run", manual: "false" } };
    expect(await processEvent(d, forged)).toEqual({ ok: true, action: "submitted", submitted: 1 });
    expect(d.submitted[0]!.items[0]).toMatchObject({ external_id: "999", distance_m: 8012.3, is_manual: false });
    // an unknown owner_id costs no Strava call; a non-activity object is ignored
    expect(await processEvent(d, { ...createEvent, owner_id: 31337 })).toEqual({ ok: true, action: "no_token" });
    expect(await processEvent(d, { ...createEvent, object_type: "club" })).toEqual({ ok: true, action: "ignored" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("red team: with STRAVA_SUBSCRIPTION_ID pinned, an event for another subscription is dropped before any Strava call", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/api/v3/activities/", () => jsonResponse(run)]]);
    const d = deps(fetch, { subscriptionId: 1 });
    expect(await processEvent(d, { ...createEvent, subscription_id: 2 })).toEqual({ ok: true, action: "foreign_subscription" });
    expect(await processEvent(d, { ...createEvent, subscription_id: undefined })).toEqual({ ok: true, action: "foreign_subscription" });
    expect(await processEvent(d, { object_type: "athlete", object_id: 4242, aspect_type: "update", owner_id: 4242, subscription_id: 2, updates: { authorized: "false" } })).toEqual({ ok: true, action: "foreign_subscription" });
    expect(fetch).not.toHaveBeenCalled();
    expect(d.deleted).toEqual([]);
    expect(await processEvent(d, createEvent)).toEqual({ ok: true, action: "submitted", submitted: 1 });
    // unset: any subscription id is accepted (the payload is never evidence anyway)
    expect(await processEvent(deps(fetch), { ...createEvent, subscription_id: 2 })).toEqual({ ok: true, action: "submitted", submitted: 1 });
  });

  it("unknown athlete: nothing to do (no token), no fetch", async () => {
    const fetch = fakeFetch([]);
    const d = deps(fetch);
    expect(await processEvent(d, { ...createEvent, owner_id: 999 })).toEqual({ ok: true, action: "no_token" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("activity delete: recorded only, nothing fetched, nothing submitted", async () => {
    const fetch = fakeFetch([]);
    const d = deps(fetch);
    expect(await processEvent(d, { ...createEvent, aspect_type: "delete" })).toEqual({ ok: true, action: "delete_recorded" });
    expect(fetch).not.toHaveBeenCalled();
    expect(d.submitted).toEqual([]);
  });

  it("athlete deauthorize deletes the tokens; other athlete updates are ignored", async () => {
    const d = deps(fakeFetch([]));
    expect(await processEvent(d, { object_type: "athlete", object_id: 4242, aspect_type: "update", owner_id: 4242, updates: { authorized: "false" } })).toEqual({ ok: true, action: "deauthorized" });
    expect(d.deleted).toEqual(["4242"]);
    expect(await processEvent(d, { object_type: "athlete", object_id: 4242, aspect_type: "update", owner_id: 4242, updates: {} })).toEqual({ ok: true, action: "ignored" });
  });

  it("a deleted-meanwhile activity (404) is not an error", async () => {
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/activities/", () => jsonResponse({ message: "Record Not Found" }, { status: 404 })]]));
    expect(await processEvent(d, createEvent)).toEqual({ ok: true, action: "not_found" });
  });

  it("a rate limit comes back as a retryable failure with retryAt, not a throw", async () => {
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/activities/", () => new Response("", { status: 429, headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "100,10" } })]]));
    expect(await processEvent(d, createEvent)).toEqual({ ok: false, error: "rate limited", retryAt: "2026-11-08T17:30:00.000Z" });
    expect(d.submitted).toEqual([]);
  });

  it("a server error or a network failure is reported, never thrown", async () => {
    expect(await processEvent(deps(fakeFetch([["GET https://www.strava.com/", () => new Response("oops", { status: 500 })]])), createEvent)).toEqual({ ok: false, error: "activity fetch: HTTP 500 oops" });
    const net = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await processEvent(deps(net), createEvent)).toEqual({ ok: false, error: "ECONNRESET" });
  });

  it("a revoked token during the fetch ends quietly (tokens deleted)", async () => {
    const d = deps(fakeFetch([
      ["GET https://www.strava.com/api/v3/activities/", () => jsonResponse({}, { status: 401 })],
      ["POST https://www.strava.com/oauth/token", () => jsonResponse({}, { status: 401 })],
    ]));
    expect(await processEvent(d, createEvent)).toEqual({ ok: true, action: "revoked" });
    expect(d.deleted).toEqual(["4242"]);
  });

  it("submit failures (the RPC) are reported with their message", async () => {
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/activities/", () => jsonResponse(run)]]), {
      submitActivities: async () => {
        throw new Error("submit_activities_for: permission denied");
      },
    });
    expect(await processEvent(d, createEvent)).toEqual({ ok: false, error: "submit_activities_for: permission denied" });
  });
});

describe("backfill", () => {
  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ ...run, id: from + i, start_date: new Date(NOW.getTime() - (i + 1) * 3600_000).toISOString() }));

  it("asks for 30 days back, 100 per page, and stops at a short page", async () => {
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/athlete/activities", (url) => {
      const u = new URL(url);
      expect(u.searchParams.get("after")).toBe(String(backfillAfterEpoch(NOW)));
      expect(u.searchParams.get("per_page")).toBe("100");
      return jsonResponse(u.searchParams.get("page") === "1" ? page(3, 100) : []);
    }]]));
    expect(await backfill(d, token())).toEqual({ fetched: 3, submitted: 3, pages: 1, stoppedBy: "end" });
    expect(d.submitted).toHaveLength(1);
    expect(d.submitted[0]!.items).toHaveLength(3);
    expect(backfillAfterEpoch(NOW)).toBe(Math.floor(NOW.getTime() / 1000) - 30 * 86_400);
  });

  it("pages through full pages and stops at the page cap", async () => {
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/athlete/activities", (url) => jsonResponse(page(100, Number(new URL(url).searchParams.get("page")) * 1000))]]));
    const s = await backfill(d, token());
    expect(s).toMatchObject({ fetched: 500, submitted: 500, pages: 5, stoppedBy: "max_pages" });
  });

  it("stops before hitting the rate limit when the headers say we are at the edge", async () => {
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/athlete/activities", (url) =>
      jsonResponse(page(100, Number(new URL(url).searchParams.get("page")) * 1000), { headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "99,10" } })]]));
    expect(await backfill(d, token())).toMatchObject({ fetched: 100, submitted: 100, pages: 1, stoppedBy: "rate_limit" });
  });

  it("a 429 mid-way keeps what was submitted and reports the stop", async () => {
    let n = 0;
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/athlete/activities", () => (++n === 1 ? jsonResponse(page(100, 1000)) : new Response("", { status: 429 }))]]));
    const s = await backfill(d, token());
    expect(s).toMatchObject({ fetched: 100, submitted: 100, pages: 1, stoppedBy: "rate_limit" });
    expect(s.error).toMatch(/rate limited/);
  });

  it("an empty window submits nothing", async () => {
    const d = deps(fakeFetch([["GET https://www.strava.com/api/v3/athlete/activities", () => jsonResponse([])]]));
    expect(await backfill(d, token())).toEqual({ fetched: 0, submitted: 0, pages: 1, stoppedBy: "end" });
    expect(d.submitted).toEqual([]);
  });

  it("a revoked token stops the backfill quietly", async () => {
    const d = deps(fakeFetch([
      ["GET https://www.strava.com/api/v3/athlete/activities", () => jsonResponse({}, { status: 401 })],
      ["POST https://www.strava.com/oauth/token", () => jsonResponse({}, { status: 400 })],
    ]));
    expect(await backfill(d, token())).toMatchObject({ stoppedBy: "revoked" });
    expect(d.deleted).toEqual(["4242"]);
  });
});

describe("ensureSubscription", () => {
  const cfg = { clientId: "cid", clientSecret: "csecret", callbackUrl: "https://ref.supabase.co/functions/v1/strava-sync/webhook", verifyToken: "vt" };

  it("returns exists when the app already has a subscription", async () => {
    const fetch = fakeFetch([["GET https://www.strava.com/api/v3/push_subscriptions", (url) => {
      const u = new URL(url);
      expect(u.searchParams.get("client_id")).toBe("cid");
      expect(u.searchParams.get("client_secret")).toBe("csecret");
      return jsonResponse([{ id: 1, callback_url: cfg.callbackUrl }]);
    }]]);
    expect(await ensureSubscription(fetch, cfg, NOW)).toEqual({ status: "exists", id: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates one when none exists, posting the callback and verify token", async () => {
    const fetch = fakeFetch([
      ["GET https://www.strava.com/api/v3/push_subscriptions", () => jsonResponse([])],
      ["POST https://www.strava.com/api/v3/push_subscriptions", (_, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("callback_url")).toBe(cfg.callbackUrl);
        expect(body.get("verify_token")).toBe("vt");
        return jsonResponse({ id: 7 }, { status: 201 });
      }],
    ]);
    expect(await ensureSubscription(fetch, cfg, NOW)).toEqual({ status: "created", id: 7 });
  });

  it("treats Strava's 'already exists' as success and fails otherwise", async () => {
    const dup = fakeFetch([
      ["GET https://www.strava.com/api/v3/push_subscriptions", () => jsonResponse([])],
      ["POST https://www.strava.com/api/v3/push_subscriptions", () => jsonResponse({ message: "Bad Request", errors: [{ resource: "PushSubscription", field: "", code: "already exists" }] }, { status: 400 })],
    ]);
    expect(await ensureSubscription(dup, cfg, NOW)).toEqual({ status: "exists", id: null });
    const bad = fakeFetch([
      ["GET https://www.strava.com/api/v3/push_subscriptions", () => jsonResponse([])],
      ["POST https://www.strava.com/api/v3/push_subscriptions", () => jsonResponse({ message: "callback url not verifiable" }, { status: 400 })],
    ]);
    await expect(ensureSubscription(bad, cfg, NOW)).rejects.toThrow(/webhook subscription failed/);
  });
});

describe("routing helpers", () => {
  it("routeOf strips the gateway prefix and the function name", () => {
    expect(routeOf("/strava-sync/callback")).toBe("callback");
    expect(routeOf("/functions/v1/strava-sync/webhook")).toBe("webhook");
    expect(routeOf("/strava-sync")).toBe("");
    expect(routeOf("/strava-sync/")).toBe("");
    expect(routeOf("/strava-sync/a/b")).toBe("a/b");
  });
  it("bearerToken extracts the token", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer   x ")).toBe("x");
    expect(bearerToken("Basic x")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});
