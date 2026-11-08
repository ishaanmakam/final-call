// strava-sync: Strava OAuth connect, webhook receiver and 30-day backfill for the activities
// evidence of goal kinds (spec: docs/superpowers/specs/2026-11-08-challenge-kinds-design.md,
// "Strava"; storage: supabase/migrations/20261109000200_strava.sql). This file only wires HTTP
// routes and supabase-js to the pure logic in strava.ts.
//
// Routes (the gateway forwards /functions/v1/strava-sync/<route> here):
//   POST /state      Authorization: Bearer <user JWT>; body {redirect?, user_id?} ->
//                    {state, connect_url}. Signs the state for the authenticated caller.
//   GET  /connect    ?state=<signed> -> 302 to Strava's authorize page.
//   GET  /callback   ?code&scope&state -> exchange, store tokens, ensure the webhook subscription,
//                    backfill 30 days, 302 to <app scheme>://settings?strava=connected (or the
//                    allow-listed web redirect carried by the state).
//   GET  /webhook    Strava's subscription handshake (hub.challenge echo when hub.verify_token matches).
//   POST /webhook    one event per delivery: logged in strava_webhook_events, acknowledged at once,
//                    processed after the response (EdgeRuntime.waitUntil) along with a few pending
//                    retries. Anything else: 404.
// Auth: /connect and /callback are authenticated by the signed state; /webhook is public per
// Strava; /state checks the user's JWT with auth.getUser. verify_jwt is therefore off for this
// function (config.toml), and nothing here ever trusts a caller-supplied user id.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type ActivityItem,
  allowedRedirect,
  authorizeUrl,
  backfill,
  bearerToken,
  callbackReturnBase,
  DEFAULT_APP_SCHEME,
  defaultReturnUrl,
  type Deps,
  ensureSubscription,
  exchangeCode,
  hasRequiredScope,
  MAX_EVENT_ATTEMPTS,
  parseOrigins,
  parseWebhookEvent,
  processEvent,
  returnUrl,
  routeOf,
  signState,
  STATE_TTL_S,
  type StoredToken,
  tokenFromResponse,
  verifyState,
  webhookChallenge,
} from "./strava.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET") ?? "";
const VERIFY_TOKEN = Deno.env.get("STRAVA_VERIFY_TOKEN") ?? "";
const STATE_SECRET = Deno.env.get("STRAVA_STATE_SECRET") ?? "";
const APP_SCHEME = Deno.env.get("APP_SCHEME") || DEFAULT_APP_SCHEME;
const WEB_ORIGINS = parseOrigins(Deno.env.get("WEB_ORIGIN") || undefined);
// Public URL of this function. Locally SUPABASE_URL is the in-Docker Kong address, so set
// STRAVA_FUNCTION_URL=http://127.0.0.1:54321/functions/v1/strava-sync when serving locally.
const FUNCTION_URL = (Deno.env.get("STRAVA_FUNCTION_URL") || `${SUPABASE_URL}/functions/v1/strava-sync`).replace(/\/+$/, "");
const PENDING_RETRY_LIMIT = 10;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS_HEADERS, ...headers } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: "strava-sync", ...entry }));
}

function logError(entry: Record<string, unknown>): void {
  console.error(JSON.stringify({ fn: "strava-sync", ...entry }));
}

function configured(): string | null {
  const missing = [
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
    ["STRAVA_CLIENT_ID", CLIENT_ID],
    ["STRAVA_CLIENT_SECRET", CLIENT_SECRET],
    ["STRAVA_VERIFY_TOKEN", VERIFY_TOKEN],
    ["STRAVA_STATE_SECRET", STATE_SECRET],
  ].filter(([, v]) => !v).map(([k]) => k);
  return missing.length ? `missing secrets: ${missing.join(", ")}` : null;
}

// ---------- Deps over supabase-js ----------

interface TokenRow {
  user_id: string;
  provider: string;
  athlete_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

const deps: Deps = {
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  tokenForAthlete: async (athleteId) => {
    const { data, error } = await db
      .from("integration_tokens")
      .select("user_id, provider, athlete_id, access_token, refresh_token, expires_at")
      .eq("provider", "strava")
      .eq("athlete_id", athleteId)
      .maybeSingle();
    check(error, "integration_tokens select");
    if (!data) return null;
    const row = data as TokenRow;
    return { user_id: row.user_id, athlete_id: row.athlete_id, access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at };
  },
  saveToken: async (t: StoredToken) => {
    const { error } = await db.rpc("upsert_integration_token", {
      p_user: t.user_id,
      p_provider: "strava",
      p_athlete_id: t.athlete_id,
      p_access_token: t.access_token,
      p_refresh_token: t.refresh_token,
      p_expires_at: t.expires_at,
      p_scope: null,
    });
    check(error, "upsert_integration_token");
  },
  deleteTokenForAthlete: async (athleteId) => {
    const { error } = await db.from("integration_tokens").delete().eq("provider", "strava").eq("athlete_id", athleteId);
    check(error, "integration_tokens delete");
  },
  submitActivities: async (userId, items: ActivityItem[]) => {
    const { data, error } = await db.rpc("submit_activities_for", { p_user: userId, p_activities: items });
    check(error, "submit_activities_for");
    return typeof data === "number" ? data : Number(data ?? 0);
  },
};

// ---------- webhook event log ----------

interface EventRow {
  id: number;
  event: unknown;
  attempts: number;
}

async function logEvent(event: unknown): Promise<number> {
  const { data, error } = await db.from("strava_webhook_events").insert({ event }).select("id").single();
  check(error, "strava_webhook_events insert");
  return (data as { id: number }).id;
}

async function markEvent(id: number, attempts: number, outcome: Awaited<ReturnType<typeof processEvent>>): Promise<void> {
  const patch = outcome.ok
    ? { processed_at: new Date().toISOString(), error: null, attempts }
    : attempts >= MAX_EVENT_ATTEMPTS
    ? { processed_at: new Date().toISOString(), error: `gave up after ${attempts} attempts: ${outcome.error}`, attempts }
    : { error: outcome.error, attempts };
  const { error } = await db.from("strava_webhook_events").update(patch).eq("id", id);
  check(error, "strava_webhook_events update");
}

async function handleLoggedEvent(row: EventRow): Promise<void> {
  const parsed = parseWebhookEvent(row.event);
  const attempts = (row.attempts ?? 0) + 1;
  if (!parsed) {
    await markEvent(row.id, MAX_EVENT_ATTEMPTS, { ok: false, error: "unrecognized event shape" });
    return;
  }
  const outcome = await processEvent(deps, parsed);
  await markEvent(row.id, attempts, outcome);
  log({ event_id: row.id, object: parsed.object_type, aspect: parsed.aspect_type, ...outcome });
}

/** Retry events an earlier delivery left unprocessed (rate limit, Strava 5xx, a cold RPC). */
async function drainPending(excludeId: number | null): Promise<void> {
  const { data, error } = await db
    .from("strava_webhook_events")
    .select("id, event, attempts")
    .is("processed_at", null)
    .lt("attempts", MAX_EVENT_ATTEMPTS)
    .lt("received_at", new Date(Date.now() - 60_000).toISOString())
    .order("id", { ascending: true })
    .limit(PENDING_RETRY_LIMIT);
  check(error, "strava_webhook_events pending select");
  for (const row of (data ?? []) as EventRow[]) {
    if (row.id === excludeId) continue;
    await handleLoggedEvent(row);
  }
}

function afterResponse(work: Promise<unknown>): void {
  const guarded = work.catch((e) => logError({ background: true, error: e instanceof Error ? e.message : String(e) }));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(guarded);
}

// ---------- routes ----------

async function handleState(req: Request): Promise<Response> {
  const jwt = bearerToken(req.headers.get("authorization"));
  if (!jwt) return json(401, { error: "sign in first" });
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) return json(401, { error: "sign in first" });
  const user = data.user;
  let body: { redirect?: unknown; user_id?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  if (typeof body.user_id === "string" && body.user_id !== user.id) return json(403, { error: "state is signed for the signed-in user only" });
  let r: string | undefined;
  if (body.redirect !== undefined && body.redirect !== null) {
    const allowed = allowedRedirect(typeof body.redirect === "string" ? body.redirect : null, { appScheme: APP_SCHEME, webOrigins: WEB_ORIGINS });
    if (!allowed) return json(400, { error: "redirect must be the app scheme or an allow-listed web origin" });
    r = allowed;
  }
  const state = await signState(STATE_SECRET, { u: user.id, e: Math.floor(Date.now() / 1000) + STATE_TTL_S, ...(r ? { r } : {}) });
  return json(200, { state, connect_url: `${FUNCTION_URL}/connect?state=${encodeURIComponent(state)}` });
}

async function handleConnect(url: URL): Promise<Response> {
  const state = url.searchParams.get("state");
  const payload = await verifyState(STATE_SECRET, state, new Date());
  if (!payload || !state) return json(400, { error: "invalid or expired state; start again from the app" });
  return redirect(authorizeUrl({ clientId: CLIENT_ID, redirectUri: `${FUNCTION_URL}/callback`, state }));
}

async function handleCallback(url: URL): Promise<Response> {
  const payload = await verifyState(STATE_SECRET, url.searchParams.get("state"), new Date());
  if (!payload) return json(400, { error: "invalid or expired state; start again from the app" });
  const back = callbackReturnBase(payload, APP_SCHEME);
  const stravaError = url.searchParams.get("error");
  if (stravaError) return redirect(returnUrl(back, "error", stravaError));
  const code = url.searchParams.get("code");
  if (!code) return redirect(returnUrl(back, "error", "no_code"));
  if (!hasRequiredScope(url.searchParams.get("scope"))) return redirect(returnUrl(back, "error", "scope"));

  let token: StoredToken;
  try {
    const t = await exchangeCode(deps.fetch, deps, code, new Date());
    token = tokenFromResponse({ user_id: payload.u, athlete_id: String(t.athlete.id) }, t);
    const { error } = await db.rpc("upsert_integration_token", {
      p_user: token.user_id,
      p_provider: "strava",
      p_athlete_id: token.athlete_id,
      p_access_token: token.access_token,
      p_refresh_token: token.refresh_token,
      p_expires_at: token.expires_at,
      p_scope: url.searchParams.get("scope"),
    });
    check(error, "upsert_integration_token");
  } catch (e) {
    logError({ route: "callback", step: "exchange", error: e instanceof Error ? e.message : String(e) });
    return redirect(returnUrl(back, "error", "exchange"));
  }
  log({ route: "callback", connected: true, user: payload.u, athlete: token.athlete_id });

  // Best effort from here: the connection is already saved.
  try {
    const sub = await ensureSubscription(deps.fetch, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, callbackUrl: `${FUNCTION_URL}/webhook`, verifyToken: VERIFY_TOKEN }, new Date());
    log({ route: "callback", subscription: sub });
  } catch (e) {
    logError({ route: "callback", step: "subscription", error: e instanceof Error ? e.message : String(e) });
  }
  try {
    const summary = await backfill(deps, token);
    log({ route: "callback", backfill: summary });
  } catch (e) {
    logError({ route: "callback", step: "backfill", error: e instanceof Error ? e.message : String(e) });
  }
  return redirect(returnUrl(back, "connected"));
}

async function handleWebhookPost(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "expected a JSON event" });
  }
  const id = await logEvent(body);
  const row: EventRow = { id, event: body, attempts: 0 };
  // Strava wants a 200 within 2 s and does not care what we do with the event; process after
  // answering when the runtime allows, inline otherwise (local `functions serve`).
  const work = handleLoggedEvent(row).then(() => drainPending(id));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    afterResponse(work);
  } else {
    await work.catch((e) => logError({ route: "webhook", error: e instanceof Error ? e.message : String(e) }));
  }
  return json(200, { received: id });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const route = routeOf(url.pathname);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const problem = configured();
  if (problem) {
    logError({ route, error: problem });
    return json(500, { error: problem });
  }
  try {
    if (route === "state" && req.method === "POST") return await handleState(req);
    if (route === "connect" && req.method === "GET") return await handleConnect(url);
    if (route === "callback" && req.method === "GET") return await handleCallback(url);
    if (route === "webhook" && req.method === "GET") {
      const answer = webhookChallenge(url.searchParams, VERIFY_TOKEN);
      return answer ? json(200, answer) : json(403, { error: "verify token mismatch" });
    }
    if (route === "webhook" && req.method === "POST") return await handleWebhookPost(req);
    return json(404, { error: "not found" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logError({ route, error: message });
    if (route === "callback") return redirect(returnUrl(defaultReturnUrl(APP_SCHEME), "error", "server"));
    return json(500, { error: message });
  }
});
