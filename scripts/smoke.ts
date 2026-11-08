// End-to-end smoke test against a REAL Supabase project (hosted or `supabase start`), driven only
// through the public surface: supabase-js, the client RPCs as two signed-in users, and the server
// jobs as the service role. One pact day from group creation to a confirmed settle-up.
//
//   cd scripts && npm install && npm run smoke
//
// Reads SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY from the repo-root .env
// (see .env.example). Without them it prints "Smoke skipped: no .env" and exits 0, so it is safe in
// CI without secrets. Exit 1 on the first mismatch.
//
// What it leaves behind (docs/DEPLOY.md, "Smoke test"): the ledger is append-only, so the group,
// pact, instance, results, ledger entries, settlement and obligation stay. The pact is paused at
// the end so cron stops generating days for it, and the two throwaway users are deleted (hard
// delete when the schema allows it; otherwise GoTrue's soft delete, which scrubs the email and
// bans the account while keeping the row the ledger references). Use a dedicated smoke/staging
// project rather than production.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.log('Smoke skipped: no .env');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
type Client = SupabaseClient<any, 'public', any>;
const STAKE = 500;

class SmokeError extends Error {}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new SmokeError(message);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    console.log(`✓ ${name}`);
    return out;
  } catch (e) {
    console.log(`✗ ${name}`);
    throw e;
  }
}

/** Call an RPC and throw on a PostgREST error (message includes the SQLSTATE when present). */
async function rpc<T = unknown>(client: Client, fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, params);
  if (error) throw new SmokeError(`${fn}: ${error.message}${error.code ? ` (${error.code})` : ''}`);
  return data as T;
}

async function select<T = any>(client: Client, build: (c: Client) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await build(client);
  if (error) throw new SmokeError(error.message);
  return (data ?? []) as T[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Server time from the `Date` header of any PostgREST response (second precision; the gateway is
 * NTP-synced). Falls back to the local clock. Deadlines are compared with server receive time, so
 * every instant below is computed from this, never from Date.now() alone.
 */
async function serverNow(): Promise<number> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: ANON_KEY } });
    const d = res.headers.get('date');
    const ms = d ? Date.parse(d) : NaN;
    if (Number.isFinite(ms)) return ms;
  } catch {
    // fall through
  }
  return Date.now();
}

/**
 * Fixed-offset zones (no DST) so local wall clock arithmetic is exact. `Etc/GMT+6` is UTC-6 (POSIX
 * sign). Pick one where it is comfortably mid-day, so the pact's window and deadline fall on the
 * same local day (create_pact requires window_open < deadline on one local day).
 */
const ZONES = [
  { name: 'Etc/UTC', offsetH: 0 },
  { name: 'Etc/GMT+6', offsetH: -6 },
  { name: 'Etc/GMT-6', offsetH: 6 },
];
function pickZone(nowMs: number) {
  for (const z of ZONES) {
    const local = new Date(nowMs + z.offsetH * 3_600_000);
    const h = local.getUTCHours() + local.getUTCMinutes() / 60;
    if (h >= 1 && h <= 21.5) return z;
  }
  return ZONES[0];
}
const localClock = (ms: number, offsetH: number) => new Date(ms + offsetH * 3_600_000).toISOString().slice(11, 19);
/** Next Monday 12:00:01 local, as a UTC instant: the first settlement due after `nowMs`. */
function nextSettlementDue(nowMs: number, offsetH: number): number {
  const local = new Date(nowMs + offsetH * 3_600_000);
  const isoDow = ((local.getUTCDay() + 6) % 7) + 1; // 1 = Mon
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (isoDow - 1));
  const dueLocal = monday + 7 * 86_400_000 + 12 * 3_600_000 + 1_000;
  return dueLocal - offsetH * 3_600_000;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
const admin: Client = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const userClient = (): Client => createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const ts = Date.now();
const users = [
  { email: `smoke+${ts}-a@example.com`, password: `Smoke-${ts}-A!x`, id: '', client: userClient() },
  { email: `smoke+${ts}-b@example.com`, password: `Smoke-${ts}-B!x`, id: '', client: userClient() },
];
const [A, B] = users;
let pactId = '';
let groupId = '';

async function cleanup(): Promise<void> {
  if (pactId && A.id) {
    try {
      await rpc(A.client, 'set_pact_paused', { p_pact: pactId, p_paused: true });
      console.log('✓ pact paused (cron will not generate further days for it)');
    } catch (e) {
      console.log(`! could not pause the pact: ${(e as Error).message}`);
    }
  }
  for (const u of users) {
    if (!u.id) continue;
    const hard = await admin.auth.admin.deleteUser(u.id);
    if (!hard.error) {
      console.log(`✓ deleted ${u.email}`);
      continue;
    }
    // profiles -> auth.users cascades, but groups.created_by, results, ledger_accounts etc. reference
    // profiles without cascade (append-only history), so a user with history cannot be hard-deleted.
    const soft = await admin.auth.admin.deleteUser(u.id, true);
    if (!soft.error) console.log(`✓ soft-deleted ${u.email} (row kept for the ledger; email scrubbed, sign-in banned)`);
    else console.log(`! could not delete ${u.email}: ${hard.error.message}; soft delete: ${soft.error.message}`);
  }
}

async function main(): Promise<void> {
  const t0 = await serverNow();
  const skewMs = t0 - Date.now();
  const zone = pickZone(t0);
  console.log(`Smoke against ${SUPABASE_URL} (server clock ${new Date(t0).toISOString()}, zone ${zone.name})`);

  await step('create two throwaway users (auth.admin.createUser, email confirmed)', async () => {
    for (const u of users) {
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
        user_metadata: { display_name: u === A ? 'Smoke A' : 'Smoke B' },
      });
      assert(!error && data.user, `createUser ${u.email}: ${error?.message}`);
      u.id = data.user.id;
    }
  });

  await step('sign both users in with the anon key', async () => {
    for (const u of users) {
      const { error } = await u.client.auth.signInWithPassword({ email: u.email, password: u.password });
      assert(!error, `signInWithPassword ${u.email}: ${error?.message}`);
    }
  });

  await step('profiles exist (handle_new_user trigger)', async () => {
    const rows = await select(admin, (c) => c.from('profiles').select('id, display_name').in('id', [A.id, B.id]));
    assert(rows.length === 2, `expected 2 profiles, got ${rows.length}`);
  });

  groupId = await step('A creates a group (create_group)', async () => {
    const id = await rpc<string>(A.client, 'create_group', { p_name: `Smoke ${new Date(t0).toISOString()}`, p_settlement_tz: zone.name });
    assert(typeof id === 'string' && id.length === 36, `unexpected group id ${id}`);
    return id;
  });

  const inviteCode = await step('A reads the invite code through RLS', async () => {
    const rows = await select<{ invite_code: string }>(A.client, (c) => c.from('groups').select('invite_code').eq('id', groupId));
    assert(rows.length === 1 && rows[0].invite_code, 'A cannot read the group row');
    return rows[0].invite_code;
  });

  await step('B joins by invite code (join_group)', async () => {
    const id = await rpc<string>(B.client, 'join_group', { p_invite_code: inviteCode });
    assert(id === groupId, `join_group returned ${id}, expected ${groupId}`);
    const members = await select(admin, (c) => c.from('group_members').select('user_id').eq('group_id', groupId).is('left_at', null));
    assert(members.length === 2, `expected 2 members, got ${members.length}`);
  });

  // The window opens shortly after now (generate_instances only creates instances whose window
  // has not opened yet) and closes 90 s later; both instants come from the server clock.
  const tPact = await serverNow();
  const windowOpenMs = Math.ceil((tPact + 25_000) / 1000) * 1000;
  const deadlineMs = windowOpenMs + 90_000;
  pactId = await step(`A creates a pact open ${localClock(windowOpenMs, zone.offsetH)}-${localClock(deadlineMs, zone.offsetH)} ${zone.name} (create_pact)`, async () => {
    const id = await rpc<string>(A.client, 'create_pact', {
      p_group: groupId,
      p_title: 'Smoke pact',
      p_days: [1, 2, 3, 4, 5, 6, 7],
      p_window_open: localClock(windowOpenMs, zone.offsetH),
      p_deadline: localClock(deadlineMs, zone.offsetH),
      p_stake_cents: STAKE,
      p_tz: zone.name,
    });
    assert(typeof id === 'string' && id.length === 36, `unexpected pact id ${id}`);
    return id;
  });

  const placeA = { lat: 47.6553, lng: -122.3035 };
  const placeB = { lat: 47.6653, lng: -122.3035 };
  await step('both join the pact with a place (join_pact)', async () => {
    await rpc(A.client, 'join_pact', { p_pact: pactId, p_lat: placeA.lat, p_lng: placeA.lng, p_radius_m: 100, p_label: 'Smoke place A' });
    await rpc(B.client, 'join_pact', { p_pact: pactId, p_lat: placeB.lat, p_lng: placeB.lng, p_radius_m: 100, p_label: 'Smoke place B' });
  });

  await step('place gate: confirm any place that waits for a friend (acknowledge_place)', async () => {
    // First places count at once (N1-1); only a changed place is gated. If a future rule gates
    // first places too, the other member confirms it here so both are on today's roster.
    const pending = await select<{ id: string; user_id: string }>(admin, (c) =>
      c.from('pact_participant_places').select('id, user_id').eq('pact_id', pactId).eq('requires_ack', true).is('acknowledged_at', null).is('objected_at', null),
    );
    for (const p of pending) {
      const other = p.user_id === A.id ? B : A;
      await rpc(other.client, 'acknowledge_place', { p_place: p.id });
    }
    const inForce = await select<{ user_id: string; effective_from: string }>(admin, (c) =>
      c.from('pact_participant_places').select('user_id, effective_from').eq('pact_id', pactId).is('objected_at', null),
    );
    const onRoster = inForce.filter((r) => Date.parse(r.effective_from) <= windowOpenMs).map((r) => r.user_id);
    assert(onRoster.includes(A.id) && onRoster.includes(B.id), `places not in force by window open: ${JSON.stringify(inForce)}`);
    console.log(`  (${pending.length} place(s) needed confirmation)`);
  });

  const instance = await step('service role generates today\'s instance (generate_instances)', async () => {
    const n = await rpc<number>(admin, 'generate_instances', { p_days_ahead: 1, p_now: new Date(await serverNow()).toISOString() });
    assert(n >= 1, `generate_instances created ${n} instances`);
    const rows = await select<{ id: string; window_open_at: string; deadline_at: string; status: string }>(admin, (c) =>
      c.from('pact_instances').select('id, window_open_at, deadline_at, status').eq('pact_id', pactId).order('window_open_at').limit(1),
    );
    assert(rows.length === 1, 'no instance generated');
    const inst = rows[0];
    assert(Math.abs(Date.parse(inst.window_open_at) - windowOpenMs) < 1000, `window_open_at ${inst.window_open_at} != ${new Date(windowOpenMs).toISOString()}`);
    assert(Math.abs(Date.parse(inst.deadline_at) - deadlineMs) < 1000, `deadline_at ${inst.deadline_at} != ${new Date(deadlineMs).toISOString()}`);
    assert(inst.status === 'scheduled', `status ${inst.status}, expected scheduled`);
    return inst;
  });

  await step('tick opens the window (tick_instances at window_open + 1 s)', async () => {
    await rpc(admin, 'tick_instances', { p_now: new Date(windowOpenMs + 1000).toISOString() });
    const [row] = await select<{ status: string }>(admin, (c) => c.from('pact_instances').select('status').eq('id', instance.id));
    assert(row?.status === 'open', `status ${row?.status}, expected open`);
  });

  await step('wait until the window is open on the server clock', async () => {
    const until = windowOpenMs + 1500 - skewMs; // local-clock instant matching server window_open + 1.5 s
    const wait = until - Date.now();
    if (wait > 0) await sleep(wait);
    const now = await serverNow();
    assert(now >= windowOpenMs, `server clock ${new Date(now).toISOString()} still before window open`);
  });

  await step('A checks in inside the fence (check_in); B does not', async () => {
    const row = await rpc<{ verdict: string }>(A.client, 'check_in', {
      p_instance: instance.id,
      p_lat: placeA.lat,
      p_lng: placeA.lng,
      p_accuracy_m: 12,
      p_client_captured_at: new Date(Date.now() + skewMs).toISOString(),
      p_is_simulated: false,
    });
    assert(row?.verdict === 'in_fence', `verdict ${row?.verdict}, expected in_fence`);
  });

  await step('tick closes the instance (tick_instances at deadline + 1 s)', async () => {
    await rpc(admin, 'tick_instances', { p_now: new Date(deadlineMs + 1000).toISOString() });
    const [row] = await select<{ status: string }>(admin, (c) => c.from('pact_instances').select('status').eq('id', instance.id));
    assert(row?.status === 'closed', `status ${row?.status}, expected closed`);
  });

  await step('results: A success, B failed', async () => {
    const rows = await select<{ user_id: string; status: string }>(admin, (c) => c.from('results').select('user_id, status').eq('instance_id', instance.id));
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r.status]));
    assert(byUser[A.id] === 'success', `A result ${byUser[A.id]}, expected success`);
    assert(byUser[B.id] === 'failed', `B result ${byUser[B.id]}, expected failed`);
    assert(rows.length === 2, `expected 2 results, got ${rows.length}`);
  });

  const balances = async () => {
    const rows = await select<{ user_id: string; balance_cents: number | string }>(admin, (c) =>
      c.from('member_balances').select('user_id, balance_cents').eq('group_id', groupId),
    );
    return Object.fromEntries(rows.map((r) => [r.user_id, Number(r.balance_cents)]));
  };

  await step(`member_balances: A +${STAKE}, B -${STAKE}`, async () => {
    const b = await balances();
    assert(b[A.id] === STAKE, `A balance ${b[A.id]}, expected ${STAKE}`);
    assert(b[B.id] === -STAKE, `B balance ${b[B.id]}, expected ${-STAKE}`);
  });

  await step('B sees the result through RLS', async () => {
    const rows = await select(B.client, (c) => c.from('results').select('user_id, status').eq('instance_id', instance.id));
    assert(rows.length === 2, `B sees ${rows.length} result rows, expected 2`);
  });

  const dueMs = nextSettlementDue(deadlineMs, zone.offsetH);
  const obligation = await step(`settlement (settle_due_groups at ${new Date(dueMs).toISOString()}) creates one obligation B -> A of ${STAKE}`, async () => {
    const n = await rpc<number>(admin, 'settle_due_groups', { p_now: new Date(dueMs).toISOString() });
    assert(n >= 1, `settle_due_groups settled ${n} groups`);
    const rows = await select<{ id: string; from_user: string; to_user: string; amount_cents: number | string; status: string }>(admin, (c) =>
      c.from('obligations').select('id, from_user, to_user, amount_cents, status').eq('group_id', groupId),
    );
    assert(rows.length === 1, `expected 1 obligation, got ${rows.length}: ${JSON.stringify(rows)}`);
    const o = rows[0];
    assert(o.from_user === B.id && o.to_user === A.id, `obligation ${o.from_user} -> ${o.to_user}, expected B -> A`);
    assert(Number(o.amount_cents) === STAKE, `obligation amount ${o.amount_cents}, expected ${STAKE}`);
    assert(o.status === 'pending', `obligation status ${o.status}, expected pending`);
    return o;
  });

  await step('B marks it paid (mark_obligation_paid), A confirms (confirm_obligation)', async () => {
    await rpc(B.client, 'mark_obligation_paid', { p_obligation: obligation.id });
    const [mid] = await select<{ status: string }>(admin, (c) => c.from('obligations').select('status').eq('id', obligation.id));
    assert(mid?.status === 'marked_paid', `status after mark ${mid?.status}`);
    await rpc(A.client, 'confirm_obligation', { p_obligation: obligation.id });
    const [done] = await select<{ status: string }>(admin, (c) => c.from('obligations').select('status').eq('id', obligation.id));
    assert(done?.status === 'confirmed', `status after confirm ${done?.status}`);
  });

  await step('member_balances are 0 and a settlement_payment entry exists', async () => {
    const b = await balances();
    assert((b[A.id] ?? 0) === 0 && (b[B.id] ?? 0) === 0, `balances after settle-up ${JSON.stringify(b)}`);
    const entries = await select<{ idempotency_key: string }>(admin, (c) =>
      c.from('ledger_entries').select('idempotency_key').eq('group_id', groupId).eq('kind', 'settlement_payment'),
    );
    assert(entries.length === 1 && entries[0].idempotency_key === `payment:${obligation.id}`, `settlement_payment entries ${JSON.stringify(entries)}`);
  });

  await step('ledger is zero-sum for the group', async () => {
    const rows = await select<{ balance_cents: number | string; kind: string }>(admin, (c) =>
      c.from('account_balances').select('kind, balance_cents').eq('group_id', groupId),
    );
    const total = rows.reduce((s, r) => s + Number(r.balance_cents), 0);
    assert(total === 0, `group accounts sum to ${total}`);
  });
}

let exitCode = 0;
try {
  await main();
  console.log('\nSmoke passed.');
} catch (e) {
  exitCode = 1;
  console.error(`\nSmoke FAILED: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
  for (const u of users) await u.client.auth.signOut().catch(() => undefined);
  if (groupId) console.log(`Left behind (append-only ledger): group ${groupId}${pactId ? `, pact ${pactId} (paused)` : ''}.`);
}
process.exit(exitCode);
