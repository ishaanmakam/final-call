// Pure logic for the push-outbox Edge Function. No Deno or Node imports: runs under both
// Deno (index.ts) and Node (vitest). Only web-standard globals (fetch, Intl, Headers) are used.

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_BATCH_SIZE = 100;
export const CLAIM_LIMIT = 100;
const DEFAULT_MINUTES_LEFT = 15;

export interface OutboxRow {
  id: number;
  user_id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  created_at?: string;
}

export interface PushTokenRow {
  user_id: string;
  token: string;
}

export interface Rendered {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: "default";
  priority: "high";
}

export interface PlannedMessage {
  rowId: number;
  userId: string;
  token: string;
  message: ExpoMessage;
}

export interface RowError {
  id: number;
  error: string;
  /** ISO instant before which the row must not be re-claimed (retryable failures only). */
  retryAt?: string;
}

export interface DeadToken {
  userId: string;
  token: string;
}

export type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: string; [k: string]: unknown } };

export interface Outcomes {
  sent: number[];
  retry: RowError[];
  drop: RowError[];
  deadTokens: DeadToken[];
}

// ---------- formatting ----------

export function formatCents(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = abs % 100;
  return rem === 0 ? `$${dollars}` : `$${dollars}.${String(rem).padStart(2, "0")}`;
}

function clockLabel(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const label = `${h12}:${String(minute).padStart(2, "0")}`;
  return hour >= 12 ? `${label} PM` : label;
}

export function formatLocalTime(p: { deadline_local?: unknown; deadline_at?: unknown; tz?: unknown }): string | null {
  if (typeof p.deadline_local === "string") {
    const m = /^(\d{1,2}):(\d{2})/.exec(p.deadline_local);
    if (m) {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour < 24 && minute < 60) return clockLabel(hour, minute);
    }
  }
  if (typeof p.deadline_at === "string" && typeof p.tz === "string") {
    const at = new Date(p.deadline_at);
    if (Number.isNaN(at.getTime())) return null;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: p.tz,
        hour: "numeric",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(at);
      const hour = Number(parts.find((x) => x.type === "hour")?.value);
      const minute = Number(parts.find((x) => x.type === "minute")?.value);
      if (Number.isFinite(hour) && Number.isFinite(minute)) return clockLabel(hour % 24, minute);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------- rendering ----------

const DATA_KEYS = ["group_id", "pact_id", "instance_id", "review_id", "settlement_id", "place_id"] as const;

/** In-app path the client opens when the notification is tapped (app/src/lib/push.ts prefers data.url). */
export function deepLinkUrl(kind: string, p: Record<string, unknown>): string | undefined {
  const instance = str(p.instance_id);
  const group = str(p.group_id);
  switch (kind) {
    case "window_open":
    case "deadline_soon": {
      // goal kinds (CA-17 payload) have no check-in screen: the pact page carries progress and the Sync row
      const pact = str(p.pact_id);
      if (isGoalKind(p) && pact) return `/pacts/${pact}`;
      return instance ? `/checkin/${instance}` : undefined;
    }
    case "result":
    case "review_opened":
      return group ? `/groups/${group}/feed` : undefined;
    case "settlement":
    case "obligation_marked_paid":
    case "obligation_disputed":
      return str(p.url) ?? (group ? `/groups/${group}/ledger` : undefined);
    case "place_changed": {
      const pact = str(p.pact_id);
      return str(p.url) ?? (pact ? `/pacts/${pact}` : undefined);
    }
    case "ops_alert":
      return str(p.url) ?? "/settings";
    default:
      return undefined;
  }
}

/** Reminders about a window that has already closed must not go out late. */
export function isStale(row: OutboxRow, p: Record<string, unknown>, now: Date): boolean {
  if (row.kind !== "window_open" && row.kind !== "deadline_soon") return false;
  const at = str(p.deadline_at);
  if (!at) return false;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) && now.getTime() > ms;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function ordinal(n: number): string {
  const i = Math.trunc(n);
  const mod100 = i % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : i % 10 === 1 ? "st" : i % 10 === 2 ? "nd" : i % 10 === 3 ? "rd" : "th";
  return `${i}${suffix}`;
}

function formatDistance(m: number): string {
  const metres = Math.max(0, Math.round(m));
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

function minutesLeft(p: Record<string, unknown>, now: Date): number {
  const at = str(p.deadline_at);
  if (at) {
    const ms = new Date(at).getTime() - now.getTime();
    if (Number.isFinite(ms)) return Math.max(1, Math.round(ms / 60_000));
  }
  return Math.max(1, Math.round(num(p.minutes_left) ?? DEFAULT_MINUTES_LEFT));
}

// ---------- challenge kinds (CA-17: kind, period, goal_value, goal_unit ride on every instance push) ----------

const METRES_PER_MILE = 1609.344;

/** distance / workouts / steps / custom: anything but the original show_up pact */
function isGoalKind(p: Record<string, unknown>): boolean {
  const kind = str(p.kind);
  return kind !== undefined && kind !== "show_up";
}

/** `goal_value` arrives as a JSON number (jsonb numeric); PostgREST-style strings are tolerated. */
function goalNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function trimDecimal(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

/**
 * The server does not know the reader's locale (CI-1): metres read as kilometres when the goal is a
 * round number of km (10000 m -> "10 km"), as miles otherwise (24140 m -> "15 mi"); counts and
 * steps carry their unit word. With `value`, renders "<value> of <goal> <unit>".
 */
function formatGoal(p: Record<string, unknown>, value?: number): string | null {
  const goal = goalNumber(p.goal_value);
  const kind = str(p.kind);
  const unit = str(p.goal_unit) ?? (kind === "distance" ? "m" : kind === "steps" ? "steps" : kind === "workouts" ? "count" : undefined);
  if (goal === undefined || goal <= 0 || !unit) return null;
  const pair = (g: string, v: string | undefined, word: string) => (v !== undefined ? `${v} of ${g} ${word}` : `${g} ${word}`);
  switch (unit) {
    case "m": {
      const km = goal >= 1000 && goal % 1000 === 0;
      const conv = (m: number) => (km ? trimDecimal(m / 1000, 1) : trimDecimal(m / METRES_PER_MILE, 1));
      return pair(conv(goal), value === undefined ? undefined : conv(value), km ? "km" : "mi");
    }
    case "count": {
      const word = goal === 1 && value === undefined ? "workout" : "workouts";
      return pair(trimDecimal(goal, 0), value === undefined ? undefined : trimDecimal(value, 0), word);
    }
    case "steps":
      return pair(Math.round(goal).toLocaleString("en-US"), value === undefined ? undefined : Math.round(value).toLocaleString("en-US"), "steps");
    default:
      return null;
  }
}

/** "6 hours" / "1 hour" from the hour mark up, minutes below it. */
function timeLeftLabel(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.max(1, Math.round(minutes / 60));
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function periodWord(p: Record<string, unknown>): string {
  switch (str(p.period)) {
    case "weekly":
      return "this week";
    case "once":
      return "the race";
    default:
      return "today";
  }
}

function renderCopy(row: OutboxRow, p: Record<string, unknown>, now: Date): { title: string; body: string } | null {
  const pact = str(p.pact_title);
  const place = str(p.place_label);
  const time = formatLocalTime(p);
  const stake = num(p.stake_cents);
  const pledge = stake !== undefined && stake > 0 ? `${formatCents(stake)} pledge` : undefined;

  // The airport voice (app/DESIGN.md "Voice"): exactly three moments, Boarding / Final call / Gate
  // closed, are named in the title. Everything else stays plain.
  switch (row.kind) {
    case "window_open": {
      const at = place ? ` at ${place}` : "";
      const when = time ? `Check in${at} by ${time}.` : place ? `Check in${at}.` : "Check in now.";
      return {
        title: `Boarding: ${pact ?? "your pact"}`,
        body: pledge ? `${when} ${pledge} on the line.` : when,
      };
    }
    case "deadline_soon": {
      const n = minutesLeft(p, now);
      let left: string;
      if (isGoalKind(p)) {
        // weekly pacts get one Final call at Sunday 18:00 local (CA-5): six hours, not minutes
        const goal = str(p.kind) === "custom" ? null : formatGoal(p);
        const todo = goal ? `reach ${goal}` : `mark ${periodWord(p)} done`;
        left = `${timeLeftLabel(n)} left to ${todo}.`;
      } else {
        left = `${n} minute${n === 1 ? "" : "s"} left to check in${place ? ` at ${place}` : ""}.`;
      }
      return {
        title: `Final call: ${pact ?? "your pact"}`,
        body: pledge ? `${left} Miss it and you forfeit your ${pledge}.` : left,
      };
    }
    case "result": {
      const title = `Gate closed: ${pact ?? "your pact"}`;
      const pledgeOr = pledge ?? "Your pledge";
      // goal kinds: "16.5 of 15 mi" when the payload carries the participant's value, the goal alone otherwise
      const goalOnly = isGoalKind(p) ? formatGoal(p) : null;
      const value = goalNumber(p.value);
      const withValue = goalOnly && value !== undefined ? formatGoal(p, value) : null;
      switch (p.status) {
        case "success": {
          const net = num(p.net_cents) ?? 0;
          const made = withValue ? `You made it: ${withValue}.` : goalOnly ? `You made it: ${goalOnly} reached.` : "You made it.";
          return {
            title,
            body: net > 0 ? `${made} +${formatCents(net)} from the pool.` : `${made} Your pledge is safe.`,
          };
        }
        case "failed": {
          const missed = withValue ? `Missed: ${withValue}.` : goalOnly ? `Missed: short of ${goalOnly}.` : "Missed.";
          return {
            title,
            body: p.rolled_over === true
              ? `${missed} ${pledgeOr} forfeited. Nobody made it, so the pool rolls over.`
              : `${missed} ${pledgeOr} forfeited to the pool. Appeal before settlement if that's wrong.`,
          };
        }
        case "unverified":
          return { title, body: "Unverified. No forfeit: your check-in couldn't be judged." };
        case "frozen":
          return { title, body: `Frozen. No pledge ${periodWord(p)}.` };
        case "void":
          return { title, body: "Didn't count. Fewer than 2 were in it, so no pledges today." };
        case "excluded":
          return { title, body: "Excluded. Your pledge was returned." };
        default:
          return null;
      }
    }
    case "review_opened": {
      const subject = str(p.subject_name) ?? "Someone";
      const opener = str(p.opener_name) ?? "Someone";
      const vote = `${pact ?? "Your pact"}: vote before settlement.`;
      if (p.system_opened === true) {
        // the unverified budget: nobody opened it, so no opener is named
        const n = num(p.unverified_this_month);
        const toSubject = str(p.subject_user_id) === row.user_id;
        const who = toSubject ? "Your" : `${subject}'s`;
        const what = n !== undefined && n > 0
          ? `${ordinal(n)} unverified day this month goes to a vote`
          : "unverified days this month go to a vote";
        return {
          title: `${who} ${what}`,
          body: toSubject ? `${pact ?? "Your pact"}: the group votes before settlement.` : vote,
        };
      }
      if (p.review_kind === "appeal") return { title: `${subject} appealed a miss`, body: vote };
      if (p.review_kind === "challenge") {
        if (str(p.subject_user_id) === row.user_id) {
          return {
            title: `${opener} challenged your ${pact ?? "pact"} result`,
            body: "The group votes before settlement.",
          };
        }
        return { title: `${opener} challenged ${subject}'s check-in`, body: vote };
      }
      return null;
    }
    case "place_changed": {
      const user = str(p.user_name) ?? "Someone";
      const actor = str(p.actor_name) ?? "Someone";
      const name = pact ?? "pact";
      const label = str(p.label);
      const prev = str(p.prev_label);
      const dist = num(p.distance_from_prev_m);
      switch (p.event) {
        case "created": {
          const isChange = prev !== undefined || dist !== undefined || p.requires_ack === true;
          if (!isChange) {
            return {
              title: `${user} joined ${name}`,
              body: `Their place is ${label ?? "not named"}. Object within 24 hours if that is not right.`,
            };
          }
          const from = prev !== undefined && dist !== undefined
            ? `, ${formatDistance(dist)} from ${prev}`
            : prev !== undefined
            ? `, was ${prev}`
            : "";
          const gate = p.requires_ack === true ? "Confirm it or object within 24 hours." : "It counts in 12 hours.";
          return { title: `${user} changed their ${name} place`, body: `${label ?? "A new place"}${from}. ${gate}` };
        }
        case "acknowledged":
          return {
            title: `${actor} confirmed your new place`,
            body: `${label ?? "It"} counts for ${name} from the next window at least 12 hours after you set it.`,
          };
        case "objected": {
          const reason = str(p.reason);
          return {
            title: `${actor} objected to your new place`,
            body: `${label ?? "It"} will not count for ${name}${reason ? `: "${reason}"` : ""}. Set a new place.`,
          };
        }
        case "effective":
          return {
            title: "Your new place now counts",
            body: `Nobody objected within 24 hours: ${label ?? "it"} is your ${name} place.`,
          };
        default:
          return null;
      }
    }
    case "settlement": {
      const net = num(p.net_cents) ?? 0;
      return {
        title: `${str(p.group_name) ?? "Your group"}: weekly settlement`,
        body: net < 0
          ? `You owe ${formatCents(net)}. Tap for Venmo links.`
          : net > 0
          ? `You're owed ${formatCents(net)}. Your group will pay you on Venmo.`
          : "You're square this week.",
      };
    }
    // RT-3: to the payee. Until they confirm or dispute, the next settlement treats it as paid.
    case "obligation_marked_paid": {
      const payer = str(p.from_name) ?? "Someone";
      const amount = num(p.amount_cents);
      return {
        title: amount !== undefined ? `${payer} marked ${formatCents(amount)} as paid` : `${payer} marked a payment as paid`,
        body: "Confirm it once it lands on Venmo, or dispute it if nothing arrived.",
      };
    }
    // RT-3: to the payer.
    case "obligation_disputed": {
      const payee = str(p.to_name) ?? "Someone";
      const amount = num(p.amount_cents);
      return {
        title: amount !== undefined ? `${payee} says ${formatCents(amount)} did not arrive` : `${payee} disputed a payment`,
        body: "Check Venmo and mark it paid again, or sort it out together.",
      };
    }
    // check_job_health (20261108000500): to the ops user only; a cron job is overdue or failing.
    case "ops_alert": {
      const job = str(p.job) ?? "unknown";
      const body = str(p.reason) ?? str(p.message) ?? "Open the dashboard and check job_health.";
      return { title: `Final Call job ${job}`, body };
    }
    default:
      return null;
  }
}

export function renderNotification(row: OutboxRow, now: Date = new Date()): Rendered | null {
  const p = row.payload && typeof row.payload === "object" ? row.payload : {};
  const copy = renderCopy(row, p, now);
  if (!copy) return null;
  const data: Record<string, unknown> = { kind: row.kind, outbox_id: row.id };
  for (const k of DATA_KEYS) if (p[k] !== undefined && p[k] !== null) data[k] = p[k];
  const url = deepLinkUrl(row.kind, p);
  if (url) data.url = url;
  return { ...copy, data };
}

// ---------- planning and batching ----------

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function planMessages(
  rows: readonly OutboxRow[],
  tokens: readonly PushTokenRow[],
  now: Date = new Date(),
): { messages: PlannedMessage[]; drops: RowError[] } {
  const byUser = new Map<string, string[]>();
  for (const t of tokens) {
    const list = byUser.get(t.user_id) ?? [];
    if (!list.includes(t.token)) list.push(t.token);
    byUser.set(t.user_id, list);
  }
  const messages: PlannedMessage[] = [];
  const drops: RowError[] = [];
  for (const row of rows) {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    if (isStale(row, payload, now)) {
      drops.push({ id: row.id, error: "stale: deadline passed" });
      continue;
    }
    const rendered = renderNotification(row, now);
    if (!rendered) {
      drops.push({ id: row.id, error: `cannot render kind '${row.kind}'` });
      continue;
    }
    const userTokens = byUser.get(row.user_id) ?? [];
    if (userTokens.length === 0) {
      drops.push({ id: row.id, error: "no push tokens" });
      continue;
    }
    for (const token of userTokens) {
      messages.push({
        rowId: row.id,
        userId: row.user_id,
        token,
        message: { to: token, ...rendered, sound: "default", priority: "high" },
      });
    }
  }
  return { messages, drops };
}

// ---------- ticket handling ----------

function ticketError(t: ExpoTicket | undefined): { code?: string; text: string } | null {
  if (!t) return { text: "missing push ticket" };
  if (t.status === "ok") return null;
  const code = typeof t.details?.error === "string" ? t.details.error : undefined;
  return { code, text: code ? `${code}: ${t.message}` : t.message };
}

export function resolveOutcomes(planned: readonly PlannedMessage[], tickets: readonly ExpoTicket[]): Outcomes {
  const perRow = new Map<number, { ok: boolean; errors: { code?: string; text: string }[] }>();
  const deadTokens: DeadToken[] = [];
  planned.forEach((m, i) => {
    const state = perRow.get(m.rowId) ?? { ok: false, errors: [] };
    perRow.set(m.rowId, state);
    const err = ticketError(tickets[i]);
    if (!err) {
      state.ok = true;
      return;
    }
    state.errors.push(err);
    if (err.code === "DeviceNotRegistered") deadTokens.push({ userId: m.userId, token: m.token });
  });

  const out: Outcomes = { sent: [], retry: [], drop: [], deadTokens };
  for (const [id, s] of perRow) {
    if (s.ok) out.sent.push(id);
    else if (s.errors.every((e) => e.code === "DeviceNotRegistered")) {
      out.drop.push({ id, error: "DeviceNotRegistered: all push tokens unregistered" });
    } else {
      out.retry.push({ id, error: s.errors.find((e) => e.code !== "DeviceNotRegistered")!.text });
    }
  }
  return out;
}

// ---------- Expo transport ----------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export async function sendExpoBatch(
  fetchFn: FetchFn,
  messages: readonly ExpoMessage[],
  opts: { accessToken?: string; url?: string; timeoutMs?: number },
): Promise<ExpoTicket[]> {
  if (messages.length === 0) return [];
  const failAll = (message: string): ExpoTicket[] => messages.map(() => ({ status: "error", message }));
  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/json",
  };
  if (opts.accessToken) headers["authorization"] = `Bearer ${opts.accessToken}`;
  let res: Response;
  try {
    res = await fetchFn(opts.url ?? EXPO_PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(messages),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
  } catch (e) {
    return failAll(`network: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return failAll(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json: { data?: unknown; errors?: { code?: string; message?: string }[] };
  try {
    json = JSON.parse(text);
  } catch {
    return failAll(`unparseable Expo response: ${text.slice(0, 200)}`);
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const e = json.errors[0];
    return failAll(`${e.code ?? "ERROR"}: ${e.message ?? "request rejected"}`);
  }
  if (!Array.isArray(json.data)) return failAll("Expo response missing data");
  return json.data as ExpoTicket[];
}

// ---------- retry backoff ----------

/** Minutes to wait before re-claiming a row after its n-th failed attempt (attempts as bumped by claim_outbox). */
const RETRY_DELAY_MINUTES = [1, 5, 15, 60] as const;

export function retryDelayMs(attempts: number): number {
  const idx = Math.min(Math.max(Math.trunc(attempts) - 1, 0), RETRY_DELAY_MINUTES.length - 1);
  return RETRY_DELAY_MINUTES[idx]! * 60_000;
}

// ---------- orchestration ----------

export interface OutboxDeps {
  now?: () => Date;
  claim(limit: number): Promise<OutboxRow[]>;
  tokensFor(userIds: string[]): Promise<PushTokenRow[]>;
  send(messages: ExpoMessage[]): Promise<ExpoTicket[]>;
  markSent(ids: number[]): Promise<void>;
  markFailed(failures: RowError[]): Promise<void>;
  markDropped(drops: RowError[]): Promise<void>;
  deleteTokens(tokens: DeadToken[]): Promise<void>;
}

export interface OutboxSummary {
  claimed: number;
  sent: number;
  retried: number;
  dropped: number;
  tokensDeleted: number;
}

export async function processOutbox(
  deps: OutboxDeps,
  opts: { limit?: number; batchSize?: number } = {},
): Promise<OutboxSummary> {
  const now = deps.now?.() ?? new Date();
  const rows = (await deps.claim(opts.limit ?? CLAIM_LIMIT)).slice().sort((a, b) => a.id - b.id);
  if (rows.length === 0) return { claimed: 0, sent: 0, retried: 0, dropped: 0, tokensDeleted: 0 };

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const tokens = await deps.tokensFor(userIds);
  const { messages, drops } = planMessages(rows, tokens, now);

  const tickets: ExpoTicket[] = [];
  for (const batch of chunk(messages, opts.batchSize ?? EXPO_BATCH_SIZE)) {
    const res = await deps.send(batch.map((m) => m.message));
    for (let i = 0; i < batch.length; i++) {
      tickets.push(res[i] ?? { status: "error", message: "missing push ticket" });
    }
  }

  const outcomes = resolveOutcomes(messages, tickets);
  const attemptsById = new Map(rows.map((r) => [r.id, r.attempts]));
  const retry: RowError[] = outcomes.retry.map((r) => ({
    ...r,
    retryAt: new Date(now.getTime() + retryDelayMs(attemptsById.get(r.id) ?? 1)).toISOString(),
  }));
  const dropped = [...drops, ...outcomes.drop];
  const seen = new Set<string>();
  const dead = outcomes.deadTokens.filter((t) => {
    const key = `${t.userId}\u0000${t.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (outcomes.sent.length) await deps.markSent(outcomes.sent);
  if (retry.length) await deps.markFailed(retry);
  if (dropped.length) await deps.markDropped(dropped);
  if (dead.length) await deps.deleteTokens(dead);

  return {
    claimed: rows.length,
    sent: outcomes.sent.length,
    retried: retry.length,
    dropped: dropped.length,
    tokensDeleted: dead.length,
  };
}

// ---------- auth ----------

export function bearerMatches(header: string | null | undefined, key: string): boolean {
  if (!header || !key) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = m[1];
  let diff = given.length ^ key.length;
  for (let i = 0; i < key.length; i++) {
    diff |= (given.charCodeAt(i % (given.length || 1)) || 0) ^ key.charCodeAt(i);
  }
  return diff === 0;
}
