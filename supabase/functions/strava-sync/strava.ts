// Pure logic for the strava-sync Edge Function. No Deno or Node imports: runs under both Deno
// (index.ts) and Node (vitest). Only web-standard globals are used (fetch, URL, crypto.subtle,
// TextEncoder, Headers, AbortSignal).
//
// What lives here: OAuth state signing, the authorize URL, the webhook verify handshake, the
// Strava -> activity item mapping (with the raw hash), Strava HTTP calls over an injected fetch
// (rate-limit aware), token refresh, webhook event processing and the 30-day backfill.
// index.ts only wires HTTP routes and supabase-js to the `Deps` below.

export const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
export const STRAVA_API = "https://www.strava.com/api/v3";
export const STRAVA_SCOPE = "activity:read_all";
export const BACKFILL_DAYS = 30;
export const BACKFILL_PER_PAGE = 100;
export const BACKFILL_MAX_PAGES = 5;
/** A signed state is good for this long between /state and /callback. */
export const STATE_TTL_S = 15 * 60;
/** Refresh an access token this close to its expiry instead of using it. */
export const REFRESH_SKEW_S = 60;
export const DEFAULT_APP_SCHEME = "finalcall";
export const DEFAULT_WEB_ORIGIN = "https://ishaanmakam.github.io";
export const MAX_EVENT_ATTEMPTS = 5;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------- base64url / crypto ----------

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality (same length required). */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------- OAuth state ----------

export interface StatePayload {
  /** Supabase user id the connection belongs to. */
  u: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** Where /callback sends the browser afterwards (already allow-listed). Absent: the app scheme. */
  r?: string;
}

/** `<base64url(json)>.<base64url(hmac)>`: the state is the whole authorization for /callback. */
export async function signState(secret: string, payload: StatePayload): Promise<string> {
  if (!secret) throw new Error("STRAVA_STATE_SECRET is not set");
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const mac = base64UrlEncode(await hmacSha256(secret, body));
  return `${body}.${mac}`;
}

export async function verifyState(secret: string, state: string | null | undefined, now: Date): Promise<StatePayload | null> {
  if (!secret || !state) return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = base64UrlEncode(await hmacSha256(secret, body));
  if (!timingSafeEqual(mac, expected)) return null;
  const raw = base64UrlDecode(body);
  if (!raw) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.u !== "string" || !/^[0-9a-f-]{36}$/i.test(p.u)) return null;
  if (typeof p.e !== "number" || !Number.isFinite(p.e)) return null;
  if (p.e * 1000 <= now.getTime()) return null;
  if (p.r !== undefined && typeof p.r !== "string") return null;
  const out: StatePayload = { u: p.u, e: p.e };
  if (typeof p.r === "string") out.r = p.r;
  return out;
}

/** Splits `WEB_ORIGIN` ("https://a.example, https://b.example") into origins. */
export function parseOrigins(value: string | undefined): string[] {
  return (value ?? DEFAULT_WEB_ORIGIN)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/**
 * A redirect the client asked for is honoured only if it is the app's own scheme or one of the
 * allow-listed web origins (open-redirect guard). Returns the normalized URL or null.
 */
export function allowedRedirect(redirect: string | null | undefined, opts: { appScheme: string; webOrigins: string[] }): string | null {
  if (!redirect) return null;
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return null;
  }
  if (url.protocol === `${opts.appScheme}:`) return url.toString();
  if ((url.protocol === "https:" || url.protocol === "http:") && opts.webOrigins.includes(url.origin)) return url.toString();
  return null;
}

export type ReturnStatus = "connected" | "error";

/** Appends `strava=connected` or `strava=error&reason=...` to a return URL, keeping its own query. */
export function returnUrl(base: string, status: ReturnStatus, reason?: string): string {
  const url = new URL(base);
  url.searchParams.set("strava", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  else url.searchParams.delete("reason");
  return url.toString();
}

export function defaultReturnUrl(appScheme: string): string {
  return `${appScheme}://settings`;
}

// ---------- authorize URL ----------

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", STRAVA_SCOPE);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

/** Strava echoes the granted scopes on the callback; the sync needs activity:read_all. */
export function hasRequiredScope(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return scope.split(",").map((s) => s.trim()).includes(STRAVA_SCOPE);
}

// ---------- webhook verify handshake ----------

/** GET /webhook: answer `{"hub.challenge": ...}` when the verify token matches, else null (403). */
export function webhookChallenge(params: URLSearchParams, verifyToken: string): { "hub.challenge": string } | null {
  if (!verifyToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const given = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (!challenge || !timingSafeEqual(given, verifyToken)) return null;
  return { "hub.challenge": challenge };
}

// ---------- mapping ----------

export type ActivityType = "running" | "walking" | "cycling" | "swimming" | "hiking" | "rowing" | "strength" | "yoga" | "other";

export interface StravaActivity {
  id: number;
  sport_type?: string | null;
  /** Legacy field, kept as a fallback for sport_type. */
  type?: string | null;
  start_date: string;
  elapsed_time: number;
  moving_time?: number | null;
  distance?: number | null;
  device_name?: string | null;
  manual?: boolean | null;
  trainer?: boolean | null;
  name?: string | null;
}

/** The item `submit_activities_for` accepts (CONTRACT: submit_activities item keys). */
export interface ActivityItem {
  source: "strava";
  external_id: string;
  activity_type: ActivityType;
  started_at: string;
  ended_at: string;
  distance_m: number | null;
  duration_s: number;
  steps: null;
  device: string | null;
  app_bundle: null;
  is_manual: boolean;
  raw_hash: string;
}

const SPORT_TYPES: Record<string, ActivityType> = {
  Run: "running",
  TrailRun: "running",
  VirtualRun: "running",
  Walk: "walking",
  Ride: "cycling",
  VirtualRide: "cycling",
  GravelRide: "cycling",
  MountainBikeRide: "cycling",
  Swim: "swimming",
  Hike: "hiking",
  Rowing: "rowing",
  VirtualRow: "rowing",
  WeightTraining: "strength",
  Crossfit: "strength",
  Yoga: "yoga",
};

export function activityTypeFor(sportType: string | null | undefined, legacyType?: string | null): ActivityType {
  const key = sportType || legacyType || "";
  return SPORT_TYPES[key] ?? "other";
}

function isoOrNull(value: string): string | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Strava activity -> submit item. `ended_at` = start + elapsed_time; `duration_s` = moving_time
 * (elapsed when Strava omits it); `is_manual` = manual (trainer rides are allowed by rule);
 * `raw_hash` = sha256 of the mapped fields so a re-delivered unchanged activity is a no-op server side.
 */
export async function mapActivity(a: StravaActivity): Promise<ActivityItem | null> {
  if (typeof a.id !== "number" || !Number.isFinite(a.id)) return null;
  const startedAt = isoOrNull(a.start_date);
  if (!startedAt) return null;
  const elapsed = Math.max(0, Math.round(Number(a.elapsed_time) || 0));
  const moving = a.moving_time === null || a.moving_time === undefined ? elapsed : Math.max(0, Math.round(Number(a.moving_time) || 0));
  const endedAt = new Date(Date.parse(startedAt) + elapsed * 1000).toISOString();
  const distance = typeof a.distance === "number" && Number.isFinite(a.distance) && a.distance > 0 ? a.distance : null;
  const device = typeof a.device_name === "string" && a.device_name.trim() ? a.device_name.trim().slice(0, 120) : null;
  const fields = {
    source: "strava" as const,
    external_id: String(a.id),
    activity_type: activityTypeFor(a.sport_type, a.type),
    started_at: startedAt,
    ended_at: endedAt,
    distance_m: distance,
    duration_s: moving,
    steps: null,
    device,
    app_bundle: null,
    is_manual: a.manual === true,
  };
  const raw_hash = await sha256Hex(
    JSON.stringify([
      fields.external_id,
      fields.activity_type,
      fields.started_at,
      fields.ended_at,
      fields.distance_m,
      fields.duration_s,
      fields.device,
      fields.is_manual,
    ]),
  );
  return { ...fields, raw_hash };
}

// ---------- Strava HTTP ----------

export interface RateLimit {
  limit15: number;
  limitDay: number;
  usage15: number;
  usageDay: number;
}

function pair(value: string | null): [number, number] | null {
  if (!value) return null;
  const parts = value.split(",").map((s) => Number(s.trim()));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0]!, parts[1]!];
}

/** Reads `X-RateLimit-*` (overall) or `X-ReadRateLimit-*` (read-only limits) headers. */
export function parseRateLimit(headers: Headers): RateLimit | null {
  const limit = pair(headers.get("x-readratelimit-limit")) ?? pair(headers.get("x-ratelimit-limit"));
  const usage = pair(headers.get("x-readratelimit-usage")) ?? pair(headers.get("x-ratelimit-usage"));
  if (!limit || !usage) return null;
  return { limit15: limit[0], limitDay: limit[1], usage15: usage[0], usageDay: usage[1] };
}

/** Strava's 15-minute windows start at :00, :15, :30, :45 UTC; the daily one at 00:00 UTC. */
export function nextQuarterHour(now: Date): Date {
  const ms = now.getTime();
  const q = 15 * 60 * 1000;
  return new Date(Math.floor(ms / q) * q + q);
}

export function nextUtcMidnight(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d;
}

export class StravaRateLimited extends Error {
  readonly retryAt: Date;
  constructor(retryAt: Date, detail?: string) {
    super(`rate limited${detail ? `: ${detail}` : ""}; retry at ${retryAt.toISOString()}`);
    this.name = "StravaRateLimited";
    this.retryAt = retryAt;
  }
}

/** True when the next read would exceed a window (leave one request of headroom). */
export function nearLimit(rl: RateLimit | null): boolean {
  if (!rl) return false;
  return rl.usage15 >= rl.limit15 - 1 || rl.usageDay >= rl.limitDay - 1;
}

export function retryAtFor(rl: RateLimit | null, now: Date): Date {
  if (rl && rl.usageDay >= rl.limitDay - 1 && rl.usage15 < rl.limit15 - 1) return nextUtcMidnight(now);
  return nextQuarterHour(now);
}

export interface StravaResponse<T> {
  status: number;
  body: T | null;
  text: string;
  rateLimit: RateLimit | null;
}

/**
 * One Strava call. Throws StravaRateLimited on 429 (and never retries by itself: the caller
 * decides what to leave for later). Network errors propagate.
 */
export async function stravaJson<T>(fetchFn: FetchFn, url: string, init: RequestInit, now: Date, timeoutMs = 15_000): Promise<StravaResponse<T>> {
  const res = await fetchFn(url, { ...init, signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined });
  const rateLimit = parseRateLimit(res.headers);
  const text = await res.text().catch(() => "");
  if (res.status === 429) throw new StravaRateLimited(retryAtFor(rateLimit, now), text.slice(0, 120));
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, text, rateLimit };
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds. */
  expires_at: number;
  athlete?: { id: number };
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

function form(fields: Record<string, string>): RequestInit {
  const body = new URLSearchParams(fields);
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() };
}

function validTokenResponse(body: unknown): body is TokenResponse {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.access_token === "string" && b.access_token.length > 0 && typeof b.refresh_token === "string" && b.refresh_token.length > 0 &&
    typeof b.expires_at === "number";
}

export async function exchangeCode(fetchFn: FetchFn, cfg: OAuthConfig, code: string, now: Date): Promise<TokenResponse & { athlete: { id: number } }> {
  const res = await stravaJson<TokenResponse>(
    fetchFn,
    STRAVA_TOKEN_URL,
    form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: "authorization_code" }),
    now,
  );
  if (res.status !== 200 || !validTokenResponse(res.body)) throw new Error(`token exchange failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  const athleteId = res.body.athlete?.id;
  if (typeof athleteId !== "number") throw new Error("token exchange response has no athlete id");
  return { ...res.body, athlete: { id: athleteId } };
}

export class TokenRevoked extends Error {
  constructor(detail: string) {
    super(`refresh rejected (token revoked?): ${detail}`);
    this.name = "TokenRevoked";
  }
}

/** Refresh. A 400/401 from the token endpoint means the athlete revoked access: TokenRevoked. */
export async function refreshAccessToken(fetchFn: FetchFn, cfg: OAuthConfig, refreshToken: string, now: Date): Promise<TokenResponse> {
  const res = await stravaJson<TokenResponse>(
    fetchFn,
    STRAVA_TOKEN_URL,
    form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    now,
  );
  if (res.status === 400 || res.status === 401) throw new TokenRevoked(`HTTP ${res.status} ${res.text.slice(0, 200)}`);
  if (res.status !== 200 || !validTokenResponse(res.body)) throw new Error(`token refresh failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  return res.body;
}

function bearer(accessToken: string): RequestInit {
  return { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } };
}

export function getActivity(fetchFn: FetchFn, accessToken: string, id: number | string, now: Date): Promise<StravaResponse<StravaActivity>> {
  return stravaJson<StravaActivity>(fetchFn, `${STRAVA_API}/activities/${encodeURIComponent(String(id))}`, bearer(accessToken), now);
}

export function listActivities(
  fetchFn: FetchFn,
  accessToken: string,
  opts: { afterEpoch: number; page: number; perPage?: number },
  now: Date,
): Promise<StravaResponse<StravaActivity[]>> {
  const url = new URL(`${STRAVA_API}/athlete/activities`);
  url.searchParams.set("after", String(Math.floor(opts.afterEpoch)));
  url.searchParams.set("page", String(opts.page));
  url.searchParams.set("per_page", String(opts.perPage ?? BACKFILL_PER_PAGE));
  return stravaJson<StravaActivity[]>(fetchFn, url.toString(), bearer(accessToken), now);
}

export interface SubscriptionConfig extends OAuthConfig {
  callbackUrl: string;
  verifyToken: string;
}

interface Subscription {
  id: number;
  callback_url?: string;
}

export interface SubscriptionResult {
  status: "exists" | "created";
  /** Strava's subscription id, when the answer carried one: the value for STRAVA_SUBSCRIPTION_ID. */
  id: number | null;
}

/**
 * One webhook subscription per Strava application. Lists first; creates if ours is missing;
 * treats Strava's "already exists" rejection as success (two first-connects racing). The id comes
 * back so the founder can pin STRAVA_SUBSCRIPTION_ID (events from any other id are ignored).
 */
export async function ensureSubscription(fetchFn: FetchFn, cfg: SubscriptionConfig, now: Date): Promise<SubscriptionResult> {
  const listUrl = new URL(`${STRAVA_API}/push_subscriptions`);
  listUrl.searchParams.set("client_id", cfg.clientId);
  listUrl.searchParams.set("client_secret", cfg.clientSecret);
  const list = await stravaJson<Subscription[]>(fetchFn, listUrl.toString(), { method: "GET", headers: { accept: "application/json" } }, now);
  if (list.status === 200 && Array.isArray(list.body) && list.body.length > 0) {
    const id = list.body[0]?.id;
    return { status: "exists", id: typeof id === "number" ? id : null };
  }
  const created = await stravaJson<Subscription | { message?: string; errors?: unknown[] }>(
    fetchFn,
    `${STRAVA_API}/push_subscriptions`,
    form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, callback_url: cfg.callbackUrl, verify_token: cfg.verifyToken }),
    now,
  );
  if (created.status === 200 || created.status === 201) {
    const id = created.body && "id" in created.body && typeof created.body.id === "number" ? created.body.id : null;
    return { status: "created", id };
  }
  if (/already exists/i.test(created.text)) return { status: "exists", id: null };
  throw new Error(`webhook subscription failed: HTTP ${created.status} ${created.text.slice(0, 200)}`);
}

// ---------- tokens with refresh ----------

export interface StoredToken {
  user_id: string;
  athlete_id: string;
  access_token: string;
  refresh_token: string;
  /** ISO instant. */
  expires_at: string;
}

export interface Deps extends OAuthConfig {
  fetch: FetchFn;
  now: () => Date;
  /**
   * Our Strava webhook subscription id (STRAVA_SUBSCRIPTION_ID). When set, an event that names
   * another subscription is ignored before any Strava call: a forged POST to the public webhook
   * then costs nothing but a log row. Unset = accept any (the payload is never trusted anyway).
   */
  subscriptionId?: number;
  tokenForAthlete(athleteId: string): Promise<StoredToken | null>;
  saveToken(token: StoredToken): Promise<void>;
  deleteTokenForAthlete(athleteId: string): Promise<void>;
  /** submit_activities_for(p_user, p_activities); returns the number of rows written. */
  submitActivities(userId: string, items: ActivityItem[]): Promise<number>;
}

export function tokenFromResponse(base: Pick<StoredToken, "user_id" | "athlete_id">, t: TokenResponse): StoredToken {
  return {
    user_id: base.user_id,
    athlete_id: base.athlete_id,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
  };
}

export function isExpiring(token: StoredToken, now: Date): boolean {
  const exp = Date.parse(token.expires_at);
  return !Number.isFinite(exp) || exp - now.getTime() < REFRESH_SKEW_S * 1000;
}

/**
 * Runs `call` with a usable access token: refreshes first when the stored one is about to
 * expire, and once more on a 401. A refusal to refresh deletes the stored token and throws
 * TokenRevoked (the athlete revoked access on Strava's side).
 */
export async function withFreshToken<T>(
  deps: Deps,
  token: StoredToken,
  call: (accessToken: string) => Promise<StravaResponse<T>>,
): Promise<{ response: StravaResponse<T>; token: StoredToken }> {
  let current = token;
  let refreshed = false;
  const refresh = async () => {
    try {
      const t = await refreshAccessToken(deps.fetch, deps, current.refresh_token, deps.now());
      current = tokenFromResponse(current, t);
      await deps.saveToken(current);
      refreshed = true;
    } catch (e) {
      if (e instanceof TokenRevoked) await deps.deleteTokenForAthlete(current.athlete_id);
      throw e;
    }
  };
  if (isExpiring(current, deps.now())) await refresh();
  let response = await call(current.access_token);
  if (response.status === 401 && !refreshed) {
    await refresh();
    response = await call(current.access_token);
  }
  if (response.status === 401) {
    await deps.deleteTokenForAthlete(current.athlete_id);
    throw new TokenRevoked("401 after a fresh token");
  }
  return { response, token: current };
}

// ---------- webhook events ----------

export interface WebhookEvent {
  object_type: "activity" | "athlete" | string;
  object_id: number;
  aspect_type: "create" | "update" | "delete" | string;
  owner_id: number;
  subscription_id?: number;
  event_time?: number;
  updates?: Record<string, string>;
}

export function parseWebhookEvent(body: unknown): WebhookEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.object_type !== "string" || typeof b.aspect_type !== "string") return null;
  if (typeof b.object_id !== "number" || typeof b.owner_id !== "number") return null;
  const out: WebhookEvent = { object_type: b.object_type, aspect_type: b.aspect_type, object_id: b.object_id, owner_id: b.owner_id };
  if (typeof b.subscription_id === "number") out.subscription_id = b.subscription_id;
  if (typeof b.event_time === "number") out.event_time = b.event_time;
  if (b.updates && typeof b.updates === "object") out.updates = b.updates as Record<string, string>;
  return out;
}

export type EventOutcome =
  | { ok: true; action: "submitted"; submitted: number }
  | { ok: true; action: "ignored" | "foreign_subscription" | "no_token" | "deauthorized" | "delete_recorded" | "revoked" | "not_found" }
  | { ok: false; error: string; retryAt?: string };

/**
 * One webhook event. Activity create/update -> fetch it with the owner's token -> one item ->
 * submit_activities_for. Deletes are recorded only (activities are append-only evidence).
 * Athlete deauthorization deletes the tokens. Never throws: failures come back as {ok: false}
 * so the caller can store them on the event row and retry later.
 *
 * Trust: Strava does not sign webhooks and `owner_id` / `object_id` are whatever the sender wrote.
 * Nothing in the event is stored as evidence: the activity is fetched from Strava with the token of
 * the athlete the event names, so a forged event can at most re-deliver that athlete's own real
 * activity (idempotent server side). With `subscriptionId` set, events for another subscription are
 * dropped before that fetch.
 */
export async function processEvent(deps: Deps, event: WebhookEvent): Promise<EventOutcome> {
  try {
    if (deps.subscriptionId !== undefined && event.subscription_id !== deps.subscriptionId) {
      return { ok: true, action: "foreign_subscription" };
    }
    if (event.object_type === "athlete") {
      if (event.aspect_type === "update" && event.updates?.authorized === "false") {
        await deps.deleteTokenForAthlete(String(event.owner_id));
        return { ok: true, action: "deauthorized" };
      }
      return { ok: true, action: "ignored" };
    }
    if (event.object_type !== "activity") return { ok: true, action: "ignored" };
    if (event.aspect_type === "delete") return { ok: true, action: "delete_recorded" };
    if (event.aspect_type !== "create" && event.aspect_type !== "update") return { ok: true, action: "ignored" };

    const token = await deps.tokenForAthlete(String(event.owner_id));
    if (!token) return { ok: true, action: "no_token" };

    let result: { response: StravaResponse<StravaActivity>; token: StoredToken };
    try {
      result = await withFreshToken(deps, token, (access) => getActivity(deps.fetch, access, event.object_id, deps.now()));
    } catch (e) {
      if (e instanceof TokenRevoked) return { ok: true, action: "revoked" };
      throw e;
    }
    const { response } = result;
    if (response.status === 404) return { ok: true, action: "not_found" };
    if (response.status !== 200 || !response.body) return { ok: false, error: `activity fetch: HTTP ${response.status} ${response.text.slice(0, 120)}` };
    const item = await mapActivity(response.body);
    if (!item) return { ok: false, error: "activity could not be mapped" };
    const n = await deps.submitActivities(token.user_id, [item]);
    return { ok: true, action: "submitted", submitted: n };
  } catch (e) {
    if (e instanceof StravaRateLimited) return { ok: false, error: "rate limited", retryAt: e.retryAt.toISOString() };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- backfill ----------

export interface BackfillSummary {
  fetched: number;
  submitted: number;
  pages: number;
  stoppedBy: "end" | "rate_limit" | "max_pages" | "revoked" | "error";
  error?: string;
}

export function backfillAfterEpoch(now: Date, days = BACKFILL_DAYS): number {
  return Math.floor(now.getTime() / 1000) - days * 86_400;
}

/**
 * Pulls the last 30 days of activities after a connect and submits them in one RPC per page.
 * Stops politely at the rate limit (the webhook keeps the account current from here on).
 */
export async function backfill(deps: Deps, token: StoredToken): Promise<BackfillSummary> {
  const summary: BackfillSummary = { fetched: 0, submitted: 0, pages: 0, stoppedBy: "end" };
  const after = backfillAfterEpoch(deps.now());
  let current = token;
  for (let page = 1; page <= BACKFILL_MAX_PAGES; page++) {
    let response: StravaResponse<StravaActivity[]>;
    try {
      const r = await withFreshToken(deps, current, (access) => listActivities(deps.fetch, access, { afterEpoch: after, page }, deps.now()));
      response = r.response;
      current = r.token;
    } catch (e) {
      if (e instanceof StravaRateLimited) return { ...summary, stoppedBy: "rate_limit", error: e.message };
      if (e instanceof TokenRevoked) return { ...summary, stoppedBy: "revoked", error: e.message };
      return { ...summary, stoppedBy: "error", error: e instanceof Error ? e.message : String(e) };
    }
    if (response.status !== 200 || !Array.isArray(response.body)) {
      return { ...summary, stoppedBy: "error", error: `list activities: HTTP ${response.status} ${response.text.slice(0, 120)}` };
    }
    summary.pages = page;
    const items = (await Promise.all(response.body.map((a) => mapActivity(a)))).filter((x): x is ActivityItem => x !== null);
    summary.fetched += response.body.length;
    if (items.length > 0) summary.submitted += await deps.submitActivities(current.user_id, items);
    if (response.body.length < BACKFILL_PER_PAGE) return summary;
    if (nearLimit(response.rateLimit)) return { ...summary, stoppedBy: "rate_limit" };
    if (page === BACKFILL_MAX_PAGES) return { ...summary, stoppedBy: "max_pages" };
  }
  return summary;
}

// ---------- routing helpers ----------

/**
 * The gateway forwards `/functions/v1/strava-sync/<route>` as `/strava-sync/<route>` (and a local
 * `functions serve` as the same); take what follows the function name. "" for the bare root.
 */
export function routeOf(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const i = parts.lastIndexOf("strava-sync");
  const rest = i >= 0 ? parts.slice(i + 1) : parts;
  return rest.join("/");
}

export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/** Where /callback should send the browser: the state's allow-listed redirect or the app scheme. */
export function callbackReturnBase(state: StatePayload, appScheme: string): string {
  return state.r ?? defaultReturnUrl(appScheme);
}
