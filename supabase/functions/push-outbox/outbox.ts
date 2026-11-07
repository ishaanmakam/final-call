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

const DATA_KEYS = ["group_id", "pact_id", "instance_id", "review_id", "settlement_id"] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function minutesLeft(p: Record<string, unknown>, now: Date): number {
  const at = str(p.deadline_at);
  if (at) {
    const ms = new Date(at).getTime() - now.getTime();
    if (Number.isFinite(ms)) return Math.max(1, Math.round(ms / 60_000));
  }
  return Math.max(1, Math.round(num(p.minutes_left) ?? DEFAULT_MINUTES_LEFT));
}

function renderCopy(row: OutboxRow, p: Record<string, unknown>, now: Date): { title: string; body: string } | null {
  const pact = str(p.pact_title);
  const place = str(p.place_label);
  const time = formatLocalTime(p);
  const stake = num(p.stake_cents);
  const pledge = stake !== undefined && stake > 0 ? `${formatCents(stake)} pledge` : undefined;

  switch (row.kind) {
    case "window_open": {
      const where = place ?? pact ?? "Your spot";
      const when = time ? `${where} by ${time}.` : `${where}.`;
      return {
        title: `Check-in open: ${pact ?? "your pact"}`,
        body: pledge ? `${when} ${pledge} on the line.` : when,
      };
    }
    case "deadline_soon": {
      const where = place ?? pact ?? "Your pact";
      const head = time ? `${where} by ${time}` : where;
      return {
        title: `${head} — ${minutesLeft(p, now)} min left`,
        body: pledge ? `Check in now or forfeit your ${pledge}.` : "Check in now.",
      };
    }
    case "result": {
      const name = pact ?? "Your pact";
      const pledgeOr = pledge ?? "Your pledge";
      switch (p.status) {
        case "success": {
          const net = num(p.net_cents) ?? 0;
          return {
            title: `${name}: you made it`,
            body: net > 0 ? `You won ${formatCents(net)} from the pool.` : "Your pledge is safe.",
          };
        }
        case "failed":
          return {
            title: `${name}: missed`,
            body: p.rolled_over === true
              ? `${pledgeOr} forfeited. Nobody made it, so the pool rolls over.`
              : `${pledgeOr} forfeited to the pool. Appeal before settlement if that's wrong.`,
          };
        case "unverified":
          return { title: `${name}: couldn't verify`, body: "No forfeit. Your check-in couldn't be judged." };
        case "frozen":
          return { title: `${name}: frozen`, body: "No pledge today." };
        case "void":
          return { title: `${name}: void`, body: "Fewer than 2 active, so no pledges today." };
        case "excluded":
          return { title: `${name}: excluded`, body: "Your pledge was returned." };
        default:
          return null;
      }
    }
    case "review_opened": {
      const subject = str(p.subject_name) ?? "Someone";
      const opener = str(p.opener_name) ?? "Someone";
      const vote = `${pact ?? "Your pact"}: vote before settlement.`;
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
  const dropped = [...drops, ...outcomes.drop];
  const seen = new Set<string>();
  const dead = outcomes.deadTokens.filter((t) => {
    const key = `${t.userId}\u0000${t.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (outcomes.sent.length) await deps.markSent(outcomes.sent);
  if (outcomes.retry.length) await deps.markFailed(outcomes.retry);
  if (dropped.length) await deps.markDropped(dropped);
  if (dead.length) await deps.deleteTokens(dead);

  return {
    claimed: rows.length,
    sent: outcomes.sent.length,
    retried: outcomes.retry.length,
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
