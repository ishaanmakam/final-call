// End-to-end simulation: multi-week usage driven only through the functions production uses.
//  - client actions: RPCs via asUser (groups, pacts, reviews, votes, leave, pause, settle-up)
//  - time-sensitive client actions: check_in_at / declare_freeze_at with an explicit p_now
//    (the RPCs are thin wrappers that pass now())
//  - cron: generate_instances / tick_instances / settle_due_groups / purge_old_locations as
//    service_role every simulated 5-15 minutes inside hot zones (hourly otherwise), and always
//    at every window open, deadline-15min, deadline, settlement time and scripted event.
// Global ledger invariants are checked after every tick.
import { beforeAll, describe, expect, it } from 'vitest';
import { simplifyDebts } from '../../packages/rules/src/index';
import { asService, asUser, createDb, createUser, expectError, rows, scalar, type DB } from './helpers/db';

// ---------------------------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------------------------
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
/** Local wall clock with a fixed UTC offset like '-07:00' -> epoch ms. */
const wall = (date: string, hm: string, offset: string) => Date.parse(`${date}T${hm}:00${offset}`);
/** America/Los_Angeles: PDT until the 2026-11-01 fall-back, PST after (no events in the gap). */
const la = (date: string, hm: string) => wall(date, hm, date >= '2026-11-01' ? '-08:00' : '-07:00');
const ny = (date: string, hm: string) => wall(date, hm, date >= '2026-11-01' ? '-05:00' : '-04:00');
const kol = (date: string, hm: string) => wall(date, hm, '+05:30');
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isoDow = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
const dateRange = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

// ---------------------------------------------------------------------------------------------
// Simulation driver
// ---------------------------------------------------------------------------------------------
interface Ev {
  at: number;
  label: string;
  phase: 'before' | 'after'; // before = user action before the cron run at that instant; after = assertion after it
  run: () => Promise<void>;
  done?: boolean;
}

async function runCrons(db: DB, t: string) {
  await asService(db, async (d) => {
    await d.query(`select public.generate_instances(7, $1::timestamptz)`, [t]);
    await d.query(`select public.tick_instances($1::timestamptz)`, [t]);
    await d.query(`select public.settle_due_groups($1::timestamptz)`, [t]);
    await d.query(`select public.purge_old_locations($1::timestamptz)`, [t]);
  });
}

interface InvariantRow {
  total: number;
  unbalanced_entries: number;
  unbalanced_groups: number;
  nonzero_pots: number;
  negative_carries: number;
  dup_keys: number;
  cross_group_lines: number;
  empty_entries: number;
}
const ZERO_INVARIANTS: InvariantRow = {
  total: 0,
  unbalanced_entries: 0,
  unbalanced_groups: 0,
  nonzero_pots: 0,
  negative_carries: 0,
  dup_keys: 0,
  cross_group_lines: 0,
  empty_entries: 0,
};

async function invariants(db: DB): Promise<InvariantRow> {
  const r = (
    await db.query<any>(`select
      (select coalesce(sum(amount_cents), 0)::bigint from public.ledger_lines) as total,
      (select count(*)::int from (select entry_id from public.ledger_lines group by entry_id having sum(amount_cents) <> 0) x) as unbalanced_entries,
      (select count(*)::int from (select a.group_id from public.ledger_lines l join public.ledger_accounts a on a.id = l.account_id
                                   group by a.group_id having sum(l.amount_cents) <> 0) x) as unbalanced_groups,
      (select count(*)::int from public.account_balances where kind = 'pot' and balance_cents <> 0) as nonzero_pots,
      (select count(*)::int from public.account_balances where kind = 'carry' and balance_cents < 0) as negative_carries,
      (select (count(*) - count(distinct idempotency_key))::int from public.ledger_entries) as dup_keys,
      (select count(*)::int from public.ledger_lines l join public.ledger_entries e on e.id = l.entry_id
                                 join public.ledger_accounts a on a.id = l.account_id where a.group_id <> e.group_id) as cross_group_lines,
      (select count(*)::int from public.ledger_entries e where not exists (select 1 from public.ledger_lines l where l.entry_id = e.id)) as empty_entries`)
  ).rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) as unknown as InvariantRow;
}

interface SimResult {
  ticks: number;
  violations: { at: string; inv: InvariantRow }[];
}

/**
 * Advance a simulated clock from `from` to `to`. Steps are 5-15 min (deterministic LCG) inside hot
 * zones, at most 1 h outside, and every `points` instant and event instant is hit exactly.
 */
async function simulate(
  db: DB,
  opts: { from: number; to: number; hot: [number, number][]; points: number[]; events: Ev[] },
): Promise<SimResult> {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  const stops = [...new Set([...opts.points, ...opts.events.map((e) => e.at)])].sort((a, b) => a - b);
  const hotStarts = opts.hot.map(([a]) => a).sort((a, b) => a - b);
  const events = [...opts.events].sort((a, b) => a.at - b.at);
  const res: SimResult = { ticks: 0, violations: [] };
  let t = opts.from;
  for (;;) {
    const now = iso(t);
    for (const e of events) if (e.at === t && e.phase === 'before') { await e.run(); e.done = true; }
    await runCrons(db, now);
    res.ticks++;
    const inv = await invariants(db);
    if (Object.values(inv).some((v) => v !== 0) && res.violations.length < 20) res.violations.push({ at: now, inv });
    for (const e of events) if (e.at === t && e.phase === 'after') { await e.run(); e.done = true; }
    if (t >= opts.to) break;
    const inHot = opts.hot.some(([a, b]) => t >= a && t < b);
    let next = t + (inHot ? (5 + (rnd() % 11)) * MIN : HOUR);
    const nextStop = stops.find((s) => s > t);
    const nextHot = hotStarts.find((s) => s > t);
    if (nextStop !== undefined) next = Math.min(next, nextStop);
    if (nextHot !== undefined) next = Math.min(next, nextHot);
    t = Math.min(next, opts.to);
  }
  const missed = events.filter((e) => !e.done).map((e) => `${iso(e.at)} ${e.label}`);
  expect(missed, 'every scripted event ran').toEqual([]);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------------------------
async function balancesOf(db: DB, groupId: string): Promise<Record<string, number>> {
  const r = await rows<{ user_id: string; b: string }>(
    db,
    `select user_id::text, balance_cents::text b from public.member_balances where group_id = $1`,
    [groupId],
  );
  return Object.fromEntries(r.map((x) => [x.user_id, Number(x.b)]));
}
/** What settlement bills: lines of settled instances + settlement payments (D7 / billable_member_balances). */
async function billableOf(db: DB, groupId: string): Promise<Record<string, number>> {
  const r = await rows<{ user_id: string; b: string }>(
    db,
    `select user_id::text, balance_cents::text b from public.billable_member_balances where group_id = $1`,
    [groupId],
  );
  return Object.fromEntries(r.map((x) => [x.user_id, Number(x.b)]));
}
/**
 * The balances a settlement computes obligations from: billable balances, with every obligation
 * still 'marked_paid' counted as provisionally paid (payer +amount, payee -amount).
 */
async function settlementInputOf(db: DB, groupId: string): Promise<Record<string, number>> {
  const b = await billableOf(db, groupId);
  const mp = await rows<{ from_user: string; to_user: string; amount_cents: string }>(
    db,
    `select from_user::text, to_user::text, amount_cents::text from public.obligations where group_id = $1 and status = 'marked_paid'`,
    [groupId],
  );
  for (const o of mp) {
    b[o.from_user] = (b[o.from_user] ?? 0) + Number(o.amount_cents);
    b[o.to_user] = (b[o.to_user] ?? 0) - Number(o.amount_cents);
  }
  return b;
}
const carryOf = async (db: DB, groupId: string) =>
  Number(
    await scalar(db, `select coalesce(sum(balance_cents), 0)::text from public.account_balances where kind = 'carry' and group_id = $1`, [groupId]),
  );
async function instanceNets(db: DB, instanceId: string): Promise<Record<string, number>> {
  const r = await rows<{ user_id: string; n: string }>(
    db,
    `select a.user_id::text, sum(l.amount_cents)::text n
       from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
       join public.ledger_accounts a on a.id = l.account_id
      where e.instance_id = $1 and a.kind = 'member'
      group by a.user_id having sum(l.amount_cents) <> 0`,
    [instanceId],
  );
  return Object.fromEntries(r.map((x) => [x.user_id, Number(x.n)]));
}
const settlementsOf = (db: DB, groupId: string) =>
  rows<{ id: string; week_start: string }>(
    db,
    `select id::text, to_char(week_start, 'YYYY-MM-DD') week_start from public.settlements where group_id = $1 order by week_start`,
    [groupId],
  );
const obligationsOf = (db: DB, settlementId: string) =>
  rows<{ id: string; from_user: string; to_user: string; amount_cents: string; status: string }>(
    db,
    `select id::text, from_user::text, to_user::text, amount_cents::text, status::text
       from public.obligations where settlement_id = $1 order by from_user, to_user`,
    [settlementId],
  );

/** Deterministic snapshot of everything the jobs could change, optionally limited to one group. */
async function snapshot(db: DB, groupId: string | null, opts: { withCoords?: boolean } = {}) {
  const g = [groupId];
  return {
    ledger: await rows(
      db,
      `select e.idempotency_key, e.kind::text, e.group_id::text, l.account_id::text, l.amount_cents::text
         from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
        where ($1::uuid is null or e.group_id = $1) order by e.idempotency_key, l.id`,
      g,
    ),
    results: await rows(
      db,
      `select r.instance_id::text, r.user_id::text, r.status::text, r.first_success_at::text, r.decided_at::text
         from public.results r join public.pact_instances i on i.id = r.instance_id join public.pacts p on p.id = i.pact_id
        where ($1::uuid is null or p.group_id = $1) order by 1, 2`,
      g,
    ),
    instances: await rows(
      db,
      `select i.id::text, i.status::text, i.carry_in_cents::text, i.closed_at::text, i.deadline_soon_sent_at::text,
              i.window_open_at::text, i.deadline_at::text
         from public.pact_instances i join public.pacts p on p.id = i.pact_id
        where ($1::uuid is null or p.group_id = $1) order by i.id`,
      g,
    ),
    obligations: await rows(
      db,
      `select id::text, settlement_id::text, from_user::text, to_user::text, amount_cents::text, status::text,
              marked_paid_at::text, confirmed_at::text
         from public.obligations where ($1::uuid is null or group_id = $1) order by id`,
      g,
    ),
    settlements: await rows(
      db,
      `select id::text, week_start::text from public.settlements where ($1::uuid is null or group_id = $1) order by id`,
      g,
    ),
    reviews: await rows(
      db,
      `select r.id::text, r.status::text, r.resolved_at::text
         from public.reviews r join public.pact_instances i on i.id = r.instance_id join public.pacts p on p.id = i.pact_id
        where ($1::uuid is null or p.group_id = $1) order by r.id`,
      g,
    ),
    outbox: await rows(
      db,
      `select id, user_id::text, kind, payload::text from public.notification_outbox
        where ($1::uuid is null or payload->>'group_id' = $1::text) order by id`,
      g,
    ),
    checkins: await rows(
      db,
      `select c.id::text, c.verdict::text, c.distance_m::text, c.accuracy_m::text, c.server_received_at::text,
              ${opts.withCoords === false ? `''` : `c.lat::text || ',' || c.lng::text`} coords
         from public.checkins c join public.pact_instances i on i.id = c.instance_id join public.pacts p on p.id = i.pact_id
        where ($1::uuid is null or p.group_id = $1) order by c.id`,
      g,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// World: users, places, check-ins
// ---------------------------------------------------------------------------------------------
interface Place {
  lat: number;
  lng: number;
}
type Fix = 'in' | 'out' | 'nofix' | 'sim';

async function checkInAt(db: DB, user: string, instance: string, place: Place, fix: Fix, nowMs: number, capturedMs?: number) {
  const lat = fix === 'nofix' ? null : fix === 'out' ? place.lat + 0.01 /* ~1.1 km */ : place.lat;
  const lng = fix === 'nofix' ? null : place.lng;
  const acc = fix === 'nofix' ? null : 15;
  const r = await db.query<any>(
    `select * from public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz)`,
    [user, instance, lat, lng, acc, iso(capturedMs ?? nowMs), fix === 'sim', null, iso(nowMs)],
  );
  return r.rows[0];
}

const instanceOf = (db: DB, pactId: string, date: string) =>
  scalar<string>(db, `select id::text from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);

/** Payers mark every pending obligation of a settlement paid; returns the obligations. */
async function markAllPaid(db: DB, settlementId: string) {
  const obs = await obligationsOf(db, settlementId);
  for (const o of obs.filter((x) => x.status === 'pending')) {
    await asUser(db, o.from_user, (d) => d.query(`select public.mark_obligation_paid($1)`, [o.id]));
  }
  return obs;
}
async function confirmAll(db: DB, settlementId: string) {
  const obs = await obligationsOf(db, settlementId);
  for (const o of obs.filter((x) => x.status === 'marked_paid')) {
    await asUser(db, o.to_user, (d) => d.query(`select public.confirm_obligation($1)`, [o.id]));
  }
}

// =============================================================================================
// Scenario A: 5 roommates, 3 weeks, America/Los_Angeles, "9am class" Mon-Fri 08:00-09:00, $5
// =============================================================================================
describe('Scenario A: 5 roommates, 3 weeks across the 2026-11-01 fall-back', () => {
  const TZ = 'America/Los_Angeles';
  const NAMES = ['A', 'B', 'C', 'D', 'E'] as const;
  type Name = (typeof NAMES)[number];
  const START = la('2026-10-19', '00:00'); // Mon 00:00 PDT
  const END = la('2026-11-09', '15:00'); // Mon 15:00 PST, after the final settle-up
  const PACT_DAYS = dateRange('2026-10-19', '2026-11-09').filter((d) => isoDow(d) <= 5);
  const MONDAY_NOONS = ['2026-10-26', '2026-11-02', '2026-11-09'].map((d) => la(d, '12:00'));

  let db: DB;
  let groupId: string;
  let pact: string;
  const id = {} as Record<Name, string>;
  const place = {} as Record<Name, Place>;
  const name = (uid: string) => (Object.entries(id).find(([, v]) => v === uid)?.[0] ?? uid) as Name;
  const byName = (rec: Record<string, number>) =>
    Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== 0).map(([k, v]) => [name(k), v]).sort());
  const expectNames = (rec: Partial<Record<Name, number>>) =>
    Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== 0).sort());
  const balances = async () => byName(await balancesOf(db, groupId));
  const billable = async () => byName(await billableOf(db, groupId));
  const nets = async (date: string) => byName(await instanceNets(db, await instanceOf(db, pact, date)));
  const inst = (date: string) => instanceOf(db, pact, date);
  // Second pact (created mid-simulation on Thu 10-29): "Sunday long run", Sun 18:00-19:00, A, B, C.
  let sunPact: string;
  const sunInst = (date: string) => instanceOf(db, sunPact, date);
  const sunNets = async (date: string) => byName(await instanceNets(db, await sunInst(date)));

  let sim: SimResult;
  const reviewRecipients: Record<string, Name[]> = {};
  const reviewIds: Record<string, string> = {};
  /** Per settled week: the obligations input (billable, marked_paid counted as paid) and carry. */
  const settlementMoments: Record<string, { input: Record<string, number>; carry: number }> = {};

  beforeAll(async () => {
    db = await createDb();
    // Names are assigned in user_id order (A < B < ... < E) so the settlement greedy's tie-break
    // (user_id asc) is deterministic and obligations can be hand-computed.
    const uids: string[] = [];
    for (let i = 0; i < NAMES.length; i++) uids.push(await createUser(db, `roommate${i + 1}@roommates.test`));
    uids.sort();
    for (const [i, n] of NAMES.entries()) {
      id[n] = uids[i];
      await db.query(`update public.profiles set display_name = $2 where id = $1`, [id[n], `Roommate ${n}`]);
      place[n] = { lat: 47.6553 + i * 0.01, lng: -122.3035 };
    }
    groupId = await asUser(db, id.A, (d) => scalar<string>(d, `select public.create_group('Roommates', $1)`, [TZ]));
    const code = await scalar<string>(db, `select invite_code from public.groups where id = $1`, [groupId]);
    for (const n of NAMES.slice(1)) await asUser(db, id[n], (d) => d.query(`select public.join_group($1)`, [code]));
    pact = await asUser(db, id.A, (d) =>
      scalar<string>(d, `select public.create_pact($1, '9am class', '{1,2,3,4,5}'::smallint[], '08:00', '09:00', 500, $2)`, [groupId, TZ]),
    );
    for (const n of NAMES) {
      await asUser(db, id[n], (d) =>
        d.query(`select public.join_pact($1, $2, $3, 100, $4)`, [pact, place[n].lat, place[n].lng, `${n}'s building`]),
      );
    }
    // Fixture writes happen at wall-clock now(); backdate to the simulated start (as other tests do).
    await db.query(`update public.groups set created_at = $2 where id = $1`, [groupId, iso(START)]);
    await db.query(`update public.group_members set joined_at = $2 where group_id = $1`, [groupId, iso(START - HOUR)]);
    await db.query(`update public.pact_participants set joined_at = $2 where pact_id = $1`, [pact, iso(START - HOUR)]);
  }, 120_000);

  it('runs 3 weeks of scripted usage; balances match hand-computed values at every checkpoint', async () => {
    const events: Ev[] = [];
    const before = (at: number, label: string, run: () => Promise<void>) => events.push({ at, label, phase: 'before', run });
    const after = (at: number, label: string, run: () => Promise<void>) => events.push({ at, label, phase: 'after', run });
    const ci = (n: Name, date: string, hm: string, fix: Fix) =>
      before(la(date, hm), `${n} ${fix} ${date} ${hm}`, async () => {
        await checkInAt(db, id[n], await inst(date), place[n], fix, la(date, hm));
      });
    const openReview = (opener: Name, subject: Name, kind: 'appeal' | 'challenge', key: string, date: string, hm: string, photo?: string) =>
      before(la(date, hm), `${opener} opens ${kind} on ${subject} (${key})`, async () => {
        const recipients = (
          await rows<{ user_id: string }>(db, `select user_id::text from public.pact_participants where pact_id = $1 and left_at is null`, [pact])
        )
          .map((r) => name(r.user_id))
          .filter((n) => n !== opener)
          .sort();
        reviewRecipients[key] = recipients;
        const instance = await inst(date);
        reviewIds[key] = await asUser(db, id[opener], (d) =>
          scalar<string>(d, `select public.open_review($1, $2, $3::public.review_kind, $4, $5)`, [
            instance,
            id[subject],
            kind,
            `${kind} by ${opener}`,
            photo ?? null,
          ]),
        );
      });
    const vote = (voter: Name, key: string, supports: boolean, at: number) =>
      before(at, `${voter} votes ${supports} on ${key}`, async () => {
        await asUser(db, id[voter], (d) => d.query(`select public.cast_vote($1, $2)`, [reviewIds[key], supports]));
      });
    const reviewStatus = (key: string) => scalar<string>(db, `select status::text from public.reviews where id = $1`, [reviewIds[key]]);
    const resultOf = async (n: Name, date: string) =>
      scalar<string>(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [await inst(date), id[n]]);
    const settlementFor = async (week: string) => (await settlementsOf(db, groupId)).find((s) => s.week_start === week);
    const settleUp = (week: string, markAt: number, confirmAt: number) => {
      before(markAt, `payers mark paid for week ${week}`, async () => {
        const s = await settlementFor(week);
        const obs = await markAllPaid(db, s!.id);
        const marked = await obligationsOf(db, s!.id);
        expect.soft(marked.every((o) => o.status === 'marked_paid'), `all marked paid ${week}`).toBe(true);
        expect.soft(marked.length).toBe(obs.length);
      });
      before(confirmAt, `payees confirm for week ${week}`, async () => {
        const s = await settlementFor(week);
        await confirmAll(db, s!.id);
        const obs = await obligationsOf(db, s!.id);
        expect.soft(obs.every((o) => o.status === 'confirmed'), `all confirmed ${week}`).toBe(true);
      });
    };
    type Bal = Partial<Record<Name, number>>;
    /**
     * live = member_balances (everything posted), billable = billable_member_balances (settled
     * instances + payments), input = billable with outstanding marked_paid obligations counted as
     * paid (defaults to billable), obligations = hand-computed greedy result.
     */
    const assertSettlement = (
      week: string,
      at: number,
      exp: { live: Bal; billable: Bal; input?: Bal; obligations: string[]; carry: number },
    ) => {
      after(at - MIN, `week ${week} not yet settled at 11:59`, async () => {
        expect.soft(await settlementFor(week), `week ${week} settled early`).toBeUndefined();
      });
      after(at, `week ${week} settled at Monday noon`, async () => {
        const s = await settlementFor(week);
        expect.soft(s, `week ${week} settled at noon`).toBeDefined();
        if (!s) return;
        expect.soft(await balances(), `live balances at settlement of ${week}`).toEqual(expectNames(exp.live));
        expect.soft(await billable(), `billable balances at settlement of ${week}`).toEqual(expectNames(exp.billable));
        const input = await settlementInputOf(db, groupId);
        expect.soft(byName(input), `settlement input of ${week}`).toEqual(expectNames(exp.input ?? exp.billable));
        expect.soft(Object.values(input).reduce((a, b) => a + b, 0), `input sums to -carry ${week}`).toBe(0 - exp.carry);
        expect.soft(await carryOf(db, groupId), `carry at settlement of ${week}`).toBe(exp.carry);
        settlementMoments[week] = { input, carry: exp.carry };
        const obs = await obligationsOf(db, s.id);
        const got = obs.map((o) => `${name(o.from_user)}->${name(o.to_user)}:${Number(o.amount_cents)}`).sort();
        const oracle = simplifyDebts(input).obligations.map((o) => `${name(o.from)}->${name(o.to)}:${o.amountCents}`).sort();
        expect.soft(got, `obligations ${week} vs simplifyDebts(billable adjusted for marked_paid)`).toEqual(oracle);
        expect.soft(got, `obligations ${week} vs hand-computed`).toEqual([...exp.obligations].sort());
        expect.soft(obs.every((o) => o.status === 'pending')).toBe(true);
        const positive = Object.values(input).filter((b) => b > 0).reduce((a, b) => a + b, 0);
        expect.soft(obs.reduce((a, o) => a + Number(o.amount_cents), 0)).toBe(positive);
      });
    };
    const obligationFrom = async (week: string, from: Name) => {
      const s = await settlementFor(week);
      const obs = (await obligationsOf(db, s!.id)).filter((o) => o.from_user === id[from]);
      expect(obs, `exactly one obligation from ${from} in ${week}`).toHaveLength(1);
      return obs[0];
    };
    const obligationStatus = (oid: string) => scalar<string>(db, `select status::text from public.obligations where id = $1`, [oid]);

    // ---------------- Week 1: Mon 2026-10-19 .. Fri 10-23 (PDT, window 15:00Z-16:00Z) ----------------
    // Mon: A,B,C,D on time, E never checks in. n=5,k=4: pot 500 -> 125 each.
    ci('A', '2026-10-19', '08:05', 'in');
    ci('B', '2026-10-19', '08:10', 'in');
    ci('C', '2026-10-19', '08:15', 'in');
    ci('D', '2026-10-19', '08:20', 'in');
    after(la('2026-10-19', '09:00'), 'Mon 10-19 nets', async () => {
      expect.soft(await nets('2026-10-19'), 'Mon 10-19').toEqual(expectNames({ A: 125, B: 125, C: 125, D: 125, E: -500 }));
    });
    // Tue: C out of fence, E no GPS fix (unverified). active A,B,C,D; k=3 pot 500 -> 166 r2 (A, B earliest).
    ci('A', '2026-10-20', '08:10', 'in');
    ci('B', '2026-10-20', '08:20', 'in');
    ci('C', '2026-10-20', '08:25', 'out');
    ci('D', '2026-10-20', '08:30', 'in');
    ci('E', '2026-10-20', '08:40', 'nofix');
    after(la('2026-10-20', '09:00'), 'Tue 10-20 nets', async () => {
      expect.soft(await resultOf('E', '2026-10-20')).toBe('unverified');
      expect.soft(await resultOf('C', '2026-10-20')).toBe('failed');
      expect.soft(await nets('2026-10-20'), 'Tue 10-20').toEqual(expectNames({ A: 167, B: 167, D: 166, C: -500 }));
    });
    // Wed: all fail (A,B out of fence, C spoofed location, D,E nothing) -> 2500 rolls into the carry.
    ci('A', '2026-10-21', '08:10', 'out');
    ci('B', '2026-10-21', '08:20', 'out');
    ci('C', '2026-10-21', '08:30', 'sim');
    after(la('2026-10-21', '09:00'), 'Wed 10-21 rollover', async () => {
      expect.soft(await resultOf('C', '2026-10-21')).toBe('failed');
      expect.soft(await nets('2026-10-21'), 'Wed 10-21').toEqual(expectNames({ A: -500, B: -500, C: -500, D: -500, E: -500 }));
      expect.soft(await carryOf(db, groupId), 'carry after all-fail').toBe(2500);
    });
    // Wed 22:00: E freezes Thursday (the night before); a second freeze that ISO week is refused.
    before(la('2026-10-21', '22:00'), 'E freezes Thu', async () => {
      await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [id.E, await inst('2026-10-22'), iso(la('2026-10-21', '22:00'))]);
      const e = await expectError(
        db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [id.E, await inst('2026-10-23'), iso(la('2026-10-21', '22:01'))]),
        /freeze already used/,
      );
      expect.soft(e.code).toBe('23514');
    });
    // Thu: A,B win; C nothing; E frozen; D's offline check-in captured 08:50 arrives 09:20.
    // At close: active A,B,C,D, k=2, pot = 2*500 + carry 2500 = 3500 -> 1750 each.
    // After D's late arrival (unverified): pot = 500 + 2500 = 3000 -> 1500 each, correction.
    ci('A', '2026-10-22', '08:05', 'in');
    ci('B', '2026-10-22', '08:10', 'in');
    after(la('2026-10-22', '09:00'), 'Thu 10-22 at close', async () => {
      expect.soft(await resultOf('E', '2026-10-22')).toBe('frozen');
      expect.soft(await nets('2026-10-22'), 'Thu 10-22 at close').toEqual(expectNames({ A: 1750, B: 1750, C: -500, D: -500 }));
      expect.soft(await carryOf(db, groupId), 'carry paid out').toBe(0);
    });
    before(la('2026-10-22', '09:20'), 'D late offline check-in', async () => {
      await checkInAt(db, id.D, await inst('2026-10-22'), place.D, 'in', la('2026-10-22', '09:20'), la('2026-10-22', '08:50'));
    });
    after(la('2026-10-22', '09:20'), 'Thu 10-22 after late arrival', async () => {
      expect.soft(await resultOf('D', '2026-10-22')).toBe('unverified');
      expect.soft(await nets('2026-10-22'), 'Thu 10-22 corrected').toEqual(expectNames({ A: 1500, B: 1500, C: -500 }));
      expect.soft(await carryOf(db, groupId)).toBe(0);
    });
    // Fri: C misses, appeals with a photo; A, B, D vote yes (3 of 4 eligible) -> success at deadline.
    // k=5, l=0, carry_in 0 -> nobody moves money.
    ci('A', '2026-10-23', '08:05', 'in');
    ci('B', '2026-10-23', '08:10', 'in');
    ci('D', '2026-10-23', '08:15', 'in');
    ci('E', '2026-10-23', '08:20', 'in');
    after(la('2026-10-23', '09:00'), 'Fri 10-23 at close', async () => {
      expect.soft(await nets('2026-10-23'), 'Fri 10-23 at close').toEqual(expectNames({ A: 125, B: 125, D: 125, E: 125, C: -500 }));
    });
    openReview('C', 'C', 'appeal', 'fri-appeal', '2026-10-23', '10:00', `${groupId}/${id.C}/sign-in-sheet.jpg`);
    vote('A', 'fri-appeal', true, la('2026-10-23', '10:10'));
    vote('B', 'fri-appeal', true, la('2026-10-23', '10:20'));
    after(la('2026-10-23', '10:20'), 'appeal still open after 2 of 4', async () => {
      expect.soft(await reviewStatus('fri-appeal')).toBe('open');
    });
    vote('D', 'fri-appeal', true, la('2026-10-23', '10:30'));
    after(la('2026-10-23', '10:30'), 'appeal accepted', async () => {
      expect.soft(await reviewStatus('fri-appeal')).toBe('accepted');
      expect.soft(await resultOf('C', '2026-10-23')).toBe('success');
      expect.soft(await nets('2026-10-23'), 'Fri 10-23 after appeal').toEqual({});
    });
    before(la('2026-10-23', '10:40'), 'late vote on resolved appeal is refused', async () => {
      await expectError(asUser(db, id.E, (d) => d.query(`select public.cast_vote($1, true)`, [reviewIds['fri-appeal']])), /already resolved/);
    });
    // Hand-computed week 1 net:
    //   A: 125 + 167 - 500 + 1500 + 0 = 1292     B: same = 1292
    //   C: 125 - 500 - 500 - 500 + 0 = -1375     D: 125 + 166 - 500 + 0 + 0 = -209
    //   E: -500 + 0 - 500 + 0 (frozen) + 0 = -1000          sum = 0, carry = 0
    after(la('2026-10-25', '23:00'), 'week 1 hand-computed balances', async () => {
      expect.soft(await balances(), 'week 1 net').toEqual(expectNames({ A: 1292, B: 1292, C: -1375, D: -209, E: -1000 }));
      expect.soft(await carryOf(db, groupId)).toBe(0);
    });

    // ---------------- Week 2: Mon 10-26 .. Fri 10-30 (PDT); the week ends on the DST change ----------------
    // Mon 10-26: A,B,C,D in, E out of fence. k=4: 125 each, E -500. It closes at 09:00, before the
    // noon settlement of week 1, but it is a week-2 instance: it stays 'closed' (still reviewable)
    // and is NOT billed until week 2's settlement.
    ci('A', '2026-10-26', '08:05', 'in');
    ci('B', '2026-10-26', '08:10', 'in');
    ci('C', '2026-10-26', '08:15', 'in');
    ci('D', '2026-10-26', '08:20', 'in');
    ci('E', '2026-10-26', '08:25', 'out');
    // live = week 1 + Mon 10-26: A 1417, B 1417, C -1250, D -84, E -1500
    // billable = week 1 only:     A 1292, B 1292, C -1375, D -209, E -1000
    // greedy (A<B<...<E): A,B tie -> A takes C (1292); B takes E (1000), D (209), C's rest (83).
    assertSettlement('2026-10-19', la('2026-10-26', '12:00'), {
      live: { A: 1417, B: 1417, C: -1250, D: -84, E: -1500 },
      billable: { A: 1292, B: 1292, C: -1375, D: -209, E: -1000 },
      obligations: ['C->A:1292', 'E->B:1000', 'D->B:209', 'C->B:83'],
      carry: 0,
    });
    after(la('2026-10-26', '12:00'), 'Mon 10-26 closed but not settled (not billed in week 1)', async () => {
      expect.soft(await scalar(db, `select status::text from public.pact_instances where id = $1`, [await inst('2026-10-26')])).toBe('closed');
      expect.soft(await nets('2026-10-26'), 'Mon 10-26').toEqual(expectNames({ A: 125, B: 125, C: 125, D: 125, E: -500 }));
    });
    // Week 1 settle-up. Every payer marks paid at 14:00. At 15:00 the payees confirm everything
    // except: (1) B disputes E's 1000 (says it never arrived: marked_paid -> pending);
    // (2) B never gets round to confirming D's 209 before the next settlement.
    const w1Held: { eToB?: string; dToB?: string } = {};
    before(la('2026-10-26', '14:00'), 'week 1 payers mark paid', async () => {
      const s = await settlementFor('2026-10-19');
      await markAllPaid(db, s!.id);
      const obs = await obligationsOf(db, s!.id);
      expect.soft(obs.every((o) => o.status === 'marked_paid'), 'all week 1 marked paid').toBe(true);
      w1Held.eToB = (await obligationFrom('2026-10-19', 'E')).id;
      w1Held.dToB = (await obligationFrom('2026-10-19', 'D')).id;
    });
    before(la('2026-10-26', '15:00'), 'week 1 payees confirm all but two; B disputes E', async () => {
      const s = await settlementFor('2026-10-19');
      // only the payee can dispute
      const notPayee = await expectError(asUser(db, id.E, (d) => d.query(`select public.dispute_obligation($1)`, [w1Held.eToB])));
      expect.soft(notPayee.code).toBe('42501');
      await asUser(db, id.B, (d) => d.query(`select public.dispute_obligation($1)`, [w1Held.eToB]));
      for (const o of await obligationsOf(db, s!.id)) {
        if (o.status !== 'marked_paid' || o.id === w1Held.dToB) continue;
        await asUser(db, o.to_user, (d) => d.query(`select public.confirm_obligation($1)`, [o.id]));
      }
      const st = Object.fromEntries((await obligationsOf(db, s!.id)).map((o) => [`${name(o.from_user)}->${name(o.to_user)}`, o.status]));
      expect.soft(st, 'week 1 obligation statuses after settle-up').toEqual({
        'C->A': 'confirmed',
        'C->B': 'confirmed',
        'D->B': 'marked_paid',
        'E->B': 'pending',
      });
      expect.soft(
        await scalar(db, `select marked_paid_at from public.obligations where id = $1`, [w1Held.eToB]),
        'dispute clears marked_paid_at',
      ).toBeNull();
    });
    // Unpaid: E's 1000 (disputed) and D's 209 (unconfirmed) are still on the books; Mon 10-26 unbilled.
    after(la('2026-10-26', '15:00'), 'after week 1 settle-up', async () => {
      expect.soft(await billable(), 'billable after week 1 settle-up').toEqual(expectNames({ B: 1209, D: -209, E: -1000 }));
      expect.soft(await balances(), 'live after week 1 settle-up').toEqual(expectNames({ A: 125, B: 1334, C: 125, D: -84, E: -1500 }));
    });
    // Tue: everyone but E checks in; A challenges B; C, D vote yes (2 of the 3 eligible: C, D, E; the
    // opener A does not vote, RT-1) -> accepted, B failed. k=3, l=2 (B, E): pot 1000 -> 333 r1 (A earliest).
    ci('A', '2026-10-27', '08:05', 'in');
    ci('B', '2026-10-27', '08:10', 'in');
    ci('C', '2026-10-27', '08:15', 'in');
    ci('D', '2026-10-27', '08:20', 'in');
    openReview('A', 'B', 'challenge', 'tue-challenge', '2026-10-27', '10:00');
    before(la('2026-10-27', '10:10'), 'A cannot vote on the challenge A opened (RT-1)', async () => {
      const e = await expectError(asUser(db, id.A, (d) => d.query(`select public.cast_vote($1, true)`, [reviewIds['tue-challenge']])));
      expect.soft(e.code).toBe('42501');
    });
    vote('C', 'tue-challenge', true, la('2026-10-27', '10:20'));
    vote('D', 'tue-challenge', true, la('2026-10-27', '10:30'));
    after(la('2026-10-27', '10:30'), 'challenge accepted', async () => {
      expect.soft(await reviewStatus('tue-challenge')).toBe('accepted');
      expect.soft(await resultOf('B', '2026-10-27')).toBe('failed');
      expect.soft(await nets('2026-10-27'), 'Tue 10-27').toEqual(expectNames({ A: 334, C: 333, D: 333, B: -500, E: -500 }));
    });
    // Wed: A,B,C in; D nothing; E no fix. k=3,l=1: 167,167,166.
    // C challenges A, D appeals; nobody votes -> both default at settlement and both results stand (N3-1).
    ci('A', '2026-10-28', '08:05', 'in');
    ci('B', '2026-10-28', '08:10', 'in');
    ci('C', '2026-10-28', '08:15', 'in');
    ci('E', '2026-10-28', '08:30', 'nofix');
    after(la('2026-10-28', '09:00'), 'Wed 10-28 nets', async () => {
      expect.soft(await nets('2026-10-28'), 'Wed 10-28').toEqual(expectNames({ A: 167, B: 167, C: 166, D: -500 }));
    });
    // D24: E is on the roster of the open Wed window, so leaving is refused until it closes.
    before(la('2026-10-28', '08:45'), 'E cannot leave during an open window', async () => {
      const e = await expectError(asUser(db, id.E, (d) => d.query(`select public.leave_group($1)`, [groupId])), /cannot leave/);
      expect.soft(e.code).toBe('23514');
    });
    openReview('C', 'A', 'challenge', 'wed-challenge', '2026-10-28', '10:00');
    openReview('D', 'D', 'appeal', 'wed-appeal', '2026-10-28', '10:10');
    // Wed 12:00: E leaves the group mid-week (also leaves the pact), still owing the disputed 1000.
    before(la('2026-10-28', '12:00'), 'E leaves', async () => {
      await asUser(db, id.E, (d) => d.query(`select public.leave_group($1)`, [groupId]));
      const t = iso(la('2026-10-28', '12:00'));
      await db.query(`update public.group_members set left_at = $2 where group_id = $1 and user_id = $3`, [groupId, t, id.E]);
      await db.query(`update public.pact_participants set left_at = $2 where pact_id = $1 and user_id = $3`, [pact, t, id.E]);
    });
    // Thu: A,B in; C out of fence; D nothing; E (left) is refused. k=2,l=2 -> 500 each.
    ci('A', '2026-10-29', '08:05', 'in');
    ci('B', '2026-10-29', '08:10', 'in');
    ci('C', '2026-10-29', '08:15', 'out');
    before(la('2026-10-29', '08:20'), 'E (left) cannot check in', async () => {
      const e = await expectError(checkInAt(db, id.E, await inst('2026-10-29'), place.E, 'in', la('2026-10-29', '08:20')));
      expect.soft(e.code).toBe('42501');
    });
    after(la('2026-10-29', '09:00'), 'Thu 10-29 nets', async () => {
      expect.soft(await nets('2026-10-29'), 'Thu 10-29').toEqual(expectNames({ A: 500, B: 500, C: -500, D: -500 }));
    });
    // Thu 12:00: A creates a second pact, "Sunday long run" (Sun 18:00-19:00, $5); A, B, C join.
    before(la('2026-10-29', '12:00'), 'A creates the Sunday pact; A, B, C join', async () => {
      sunPact = await asUser(db, id.A, (d) =>
        scalar<string>(d, `select public.create_pact($1, 'Sunday long run', '{7}'::smallint[], '18:00', '19:00', 500, $2)`, [groupId, TZ]),
      );
      for (const n of ['A', 'B', 'C'] as Name[]) {
        await asUser(db, id[n], (d) => d.query(`select public.join_pact($1, $2, $3, 100, $4)`, [sunPact, place[n].lat, place[n].lng, `${n}'s park`]));
      }
      // join_pact stamps wall-clock now(); move the join and first place to the simulated instant.
      const t = iso(la('2026-10-29', '12:00'));
      await db.query(`update public.pact_participants set joined_at = $2 where pact_id = $1`, [sunPact, t]);
      await db.query(`update public.pact_participant_places set effective_from = $2 where pact_id = $1`, [sunPact, t]);
    });
    // Fri: only D. k=1,l=3 -> D +1500.
    ci('D', '2026-10-30', '08:30', 'in');
    after(la('2026-10-30', '09:00'), 'Fri 10-30 nets', async () => {
      expect.soft(await nets('2026-10-30'), 'Fri 10-30').toEqual(expectNames({ D: 1500, A: -500, B: -500, C: -500 }));
    });
    // Sun 11-01 (PST, the fall-back day) 18:00-19:00: A and C run; B doesn't check in (on time).
    // k=2, l=1: pot 500 -> A 250, C 250, B -500.
    const ciSun = (n: Name, date: string, hm: string, fix: Fix) =>
      before(la(date, hm), `${n} ${fix} Sunday pact ${date} ${hm}`, async () => {
        await checkInAt(db, id[n], await sunInst(date), place[n], fix, la(date, hm));
      });
    ciSun('A', '2026-11-01', '18:10', 'in');
    ciSun('C', '2026-11-01', '18:20', 'in');
    after(la('2026-11-01', '19:00'), 'Sun 11-01 nets at close', async () => {
      expect.soft(await sunNets('2026-11-01'), 'Sun 11-01 at close').toEqual(expectNames({ A: 250, C: 250, B: -500 }));
    });
    // Sun 11-01 23:00 (PST): live = after week 1 settle-up + Tue..Fri + Sunday.
    //   Tue..Fri: A 334+167+500-500 = 501   B -500+167+500-500 = -333   C 333+166-500-500 = -501
    //             D 333-500-500+1500 = 833  E -500
    //   A 125+501+250 = 876   B 1334-333-500 = 501   C 125-501+250 = -126   D -84+833 = 749   E -1500-500 = -2000
    after(la('2026-11-01', '23:00'), 'week 2 balances before settlement', async () => {
      expect.soft(await balances(), 'week 2 pre-settlement').toEqual(expectNames({ A: 876, B: 501, C: -126, D: 749, E: -2000 }));
      expect.soft(await billable(), 'nothing new billed mid-week').toEqual(expectNames({ B: 1209, D: -209, E: -1000 }));
      expect.soft(await reviewStatus('wed-challenge')).toBe('open');
      expect.soft(await reviewStatus('wed-appeal')).toBe('open');
    });

    // ---------------- Week 3: Mon 11-02 .. Fri 11-06 (PST, window 16:00Z-17:00Z) ----------------
    // Mon: A,B,C in; D out of fence. 167,167,166, D -500.
    ci('A', '2026-11-02', '08:05', 'in');
    ci('B', '2026-11-02', '08:10', 'in');
    ci('C', '2026-11-02', '08:15', 'in');
    ci('D', '2026-11-02', '08:20', 'out');
    after(la('2026-11-02', '11:00'), 'no settlement at 12:00 PDT (= 11:00 PST)', async () => {
      expect.soft(await settlementFor('2026-10-26'), 'settled at the PDT noon').toBeUndefined();
    });
    // Settlement defaults: C's challenge on A and D's appeal both leave the result standing (N3-1), so
    // Wed 10-28 stays A 167, B 167, C 166, D -500 and no correction posts. Mon 11-02 closed at 09:00:
    //   live      A 876+167 = 1043, B 501+167 = 668, C -126+166 = 40, D 749-500 = 249, E -2000
    // Mon 11-02 is closed but unsettled, so billable excludes it; the Sunday instance is settled:
    //   billable  A 876, B 501, C -126, D 749, E -2000
    // (1) E's disputed 1000 was superseded and is billed again; (2) D's 209 is still marked_paid,
    // so it counts as paid: D +209, B -209:
    //   input     A 876, B 292, C -126, D 958, E -2000
    // greedy: E->D 958, E->A 876, E->B 166, C->B 126.
    assertSettlement('2026-10-26', la('2026-11-02', '12:00'), {
      live: { A: 1043, B: 668, C: 40, D: 249, E: -2000 },
      billable: { A: 876, B: 501, C: -126, D: 749, E: -2000 },
      input: { A: 876, B: 292, C: -126, D: 958, E: -2000 },
      obligations: ['E->D:958', 'E->A:876', 'E->B:166', 'C->B:126'],
      carry: 0,
    });
    after(la('2026-11-02', '12:00'), 'week 1 leftovers: disputed superseded, unconfirmed survives', async () => {
      expect.soft(await obligationStatus(w1Held.eToB!), '(1) disputed obligation superseded').toBe('superseded');
      expect.soft(await obligationStatus(w1Held.dToB!), '(2) marked_paid obligation survives settlement').toBe('marked_paid');
      const eOwes = (await obligationsOf(db, (await settlementFor('2026-10-26'))!.id))
        .filter((o) => o.from_user === id.E)
        .reduce((a, o) => a + Number(o.amount_cents), 0);
      expect.soft(eOwes, '(1) E re-billed: disputed 1000 + week 2 1000').toBe(2000);
    });
    before(la('2026-11-02', '12:10'), 'superseded obligation can no longer be confirmed, disputed or marked', async () => {
      for (const [who, fn] of [
        ['B', 'confirm_obligation'],
        ['B', 'dispute_obligation'],
        ['E', 'mark_obligation_paid'],
      ] as const) {
        const e = await expectError(asUser(db, id[who], (d) => d.query(`select public.${fn}($1)`, [w1Held.eToB])), /superseded/);
        expect.soft(e.code, fn).toBe('23514');
      }
      // repeat mark by the payer of the surviving marked_paid obligation is a no-op
      await asUser(db, id.D, (d) => d.query(`select public.mark_obligation_paid($1)`, [w1Held.dToB]));
      expect.soft(await obligationStatus(w1Held.dToB!)).toBe('marked_paid');
    });
    after(la('2026-11-02', '12:00'), 'Sunday instance settled with week 2', async () => {
      expect.soft(await scalar(db, `select status::text from public.pact_instances where id = $1`, [await sunInst('2026-11-01')])).toBe('settled');
    });
    // (3) B's phone was offline on Sunday. Mon 12:20 a late OUT-of-fence tap (captured 18:40) arrives:
    // it stays failed (D27), nothing changes. Mon 12:30 a late IN-fence tap (captured 18:50) arrives,
    // 17.5 h after the deadline, on an instance that is already settled: B -> unverified, so B is not
    // active, k=2 l=0 -> nobody moves money. Correction: A -250, C -250, B +500, billed next week.
    before(la('2026-11-02', '12:20'), 'B late out-of-fence tap for Sunday', async () => {
      const c = await checkInAt(db, id.B, await sunInst('2026-11-01'), place.B, 'out', la('2026-11-02', '12:20'), la('2026-11-01', '18:40'));
      expect.soft(c.verdict).toBe('out_of_fence');
    });
    after(la('2026-11-02', '12:20'), 'late out-of-fence stays failed', async () => {
      expect.soft(await scalar(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [await sunInst('2026-11-01'), id.B])).toBe('failed');
      expect.soft(await sunNets('2026-11-01')).toEqual(expectNames({ A: 250, C: 250, B: -500 }));
    });
    before(la('2026-11-02', '12:30'), 'B late in-fence tap for Sunday (settled instance)', async () => {
      const c = await checkInAt(db, id.B, await sunInst('2026-11-01'), place.B, 'in', la('2026-11-02', '12:30'), la('2026-11-01', '18:50'));
      expect.soft(c.verdict).toBe('in_fence');
    });
    after(la('2026-11-02', '12:30'), 'Sunday corrected after settlement', async () => {
      const sun = await sunInst('2026-11-01');
      expect.soft(await scalar(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [sun, id.B])).toBe('unverified');
      expect.soft(await scalar(db, `select status::text from public.pact_instances where id = $1`, [sun])).toBe('settled');
      expect.soft(await sunNets('2026-11-01'), 'Sun 11-01 corrected').toEqual({});
      expect.soft(
        await scalar<number>(db, `select count(*)::int from public.ledger_entries where instance_id = $1 and kind = 'correction'`, [sun]),
      ).toBe(1);
      // week 2's obligations were computed before the correction and stay as they are
      const obs = await obligationsOf(db, (await settlementFor('2026-10-26'))!.id);
      expect.soft(obs.map((o) => `${name(o.from_user)}->${name(o.to_user)}:${o.amount_cents}`).sort()).toEqual(
        ['E->D:958', 'E->A:876', 'E->B:166', 'C->B:126'].sort(),
      );
      // the correction is billable right away (the instance is settled) -> picked up next Monday
      expect.soft(await billable(), 'billable incl. correction').toEqual(expectNames({ A: 626, B: 1001, C: -376, D: 749, E: -2000 }));
    });
    after(la('2026-11-02', '12:00'), 'week 2 reviews defaulted', async () => {
      expect.soft(await reviewStatus('wed-challenge')).toBe('defaulted');
      expect.soft(await reviewStatus('wed-appeal')).toBe('defaulted');
      expect.soft(await resultOf('A', '2026-10-28')).toBe('success');
      expect.soft(await resultOf('D', '2026-10-28')).toBe('failed'); // N3-1: a defaulted appeal leaves the miss
      expect.soft(await nets('2026-10-28'), 'Wed 10-28 after defaults').toEqual(expectNames({ A: 167, B: 167, C: 166, D: -500 }));
      expect.soft(
        await scalar<number>(db, `select count(*)::int from public.ledger_entries where instance_id = $1 and kind = 'correction'`, [await inst('2026-10-28')]),
        'no correction for a defaulted appeal',
      ).toBe(0);
      const st = await rows<{ local_date: string; status: string }>(
        db,
        `select to_char(local_date, 'YYYY-MM-DD') local_date, status::text from public.pact_instances where pact_id = $1 and local_date <= '2026-11-02' order by 1`,
        [pact],
      );
      expect.soft(st.filter((s) => s.local_date < '2026-11-02').every((s) => s.status === 'settled')).toBe(true);
      expect.soft(st.find((s) => s.local_date === '2026-11-02')?.status).toBe('closed');
    });
    settleUp('2026-10-26', la('2026-11-02', '14:00'), la('2026-11-02', '15:00'));
    // (2) A week late, B finally confirms D's week-1 payment: the surviving obligation still works.
    before(la('2026-11-02', '15:30'), 'B confirms the week-1 obligation that survived settlement', async () => {
      await asUser(db, id.B, (d) => d.query(`select public.confirm_obligation($1)`, [w1Held.dToB]));
      expect.soft(await obligationStatus(w1Held.dToB!)).toBe('confirmed');
      expect.soft(
        await scalar<number>(db, `select count(*)::int from public.ledger_entries where idempotency_key = $1`, [`payment:${w1Held.dToB}`]),
      ).toBe(1);
    });
    // Everything billed so far is paid (E paid after leaving). What's left: the Sunday correction
    // (billable, not yet billed) and Mon 11-02 (A 167, B 167, C 166, D -500; closed, unsettled).
    after(la('2026-11-02', '15:30'), 'after week 2 settle-up', async () => {
      expect.soft(await billable(), 'billable after week 2 settle-up').toEqual(expectNames({ A: -250, B: 500, C: -250 }));
      expect.soft(await balances(), 'live after week 2 settle-up').toEqual(expectNames({ A: -83, B: 667, C: -84, D: -500 }));
    });
    before(la('2026-11-02', '16:00'), 'A pauses the Sunday pact', async () => {
      await asUser(db, id.A, (d) => d.query(`select public.set_pact_paused($1, true)`, [sunPact]));
    });
    // Tue: only A. A +1500; B,C,D -500. B's check-in captured after the deadline is refused.
    ci('A', '2026-11-03', '08:10', 'in');
    ci('C', '2026-11-03', '08:20', 'out');
    before(la('2026-11-03', '09:10'), 'post-deadline capture refused', async () => {
      const e = await expectError(
        checkInAt(db, id.B, await inst('2026-11-03'), place.B, 'in', la('2026-11-03', '09:10'), la('2026-11-03', '09:05')),
        /window is closed/,
      );
      expect.soft(e.code).toBe('23514');
    });
    // Wed: B,C,D in; A nothing. 167,167,166; A -500.
    ci('B', '2026-11-04', '08:10', 'in');
    ci('C', '2026-11-04', '08:20', 'in');
    ci('D', '2026-11-04', '08:30', 'in');
    // Thu: all four in: k=4, l=0, carry 0 -> no money.
    ci('A', '2026-11-05', '08:05', 'in');
    ci('B', '2026-11-05', '08:10', 'in');
    ci('C', '2026-11-05', '08:15', 'in');
    ci('D', '2026-11-05', '08:20', 'in');
    // Fri: all fail -> carry 2000, which stays riding (A pauses the pact afterwards).
    ci('A', '2026-11-06', '08:10', 'out');
    after(la('2026-11-06', '09:00'), 'Fri 11-06 rollover', async () => {
      expect.soft(await nets('2026-11-06'), 'Fri 11-06').toEqual(expectNames({ A: -500, B: -500, C: -500, D: -500 }));
      expect.soft(await carryOf(db, groupId)).toBe(2000);
    });
    before(la('2026-11-06', '10:00'), 'A pauses the pact', async () => {
      await asUser(db, id.A, (d) => d.query(`select public.set_pact_paused($1, true)`, [pact]));
    });
    // Tue..Fri: A 1500-500+0-500 = 500   B -500+167-500 = -833   C -500+167-500 = -833   D -500+166-500 = -834
    // + after week 2 settle-up (A -83, B 667, C -84, D -500):
    //   A 417   B -166   C -917   D -1334
    after(la('2026-11-08', '23:00'), 'week 3 balances before settlement', async () => {
      expect.soft(await balances(), 'week 3 pre-settlement').toEqual(expectNames({ A: 417, B: -166, C: -917, D: -1334 }));
      expect.soft(await carryOf(db, groupId)).toBe(2000);
      expect.soft(
        await scalar(db, `select status::text from public.pact_instances where pact_id = $1 and local_date = '2026-11-08'`, [sunPact]),
        'Sun 11-08 voided by the pause',
      ).toBe('voided');
      const mon = await rows<{ status: string; n: number }>(
        db,
        `select i.status::text, (select count(*)::int from public.results r where r.instance_id = i.id) n
           from public.pact_instances i where pact_id = $1 and local_date = '2026-11-09'`,
        [pact],
      );
      expect.soft(mon, 'Mon 11-09 voided by the pause').toEqual([{ status: 'voided', n: 0 }]);
    });
    // Everything is settled now (Mon 11-09 voided), so live = billable = input; the Sunday correction
    // (B +500, A -250, C -250) is billed here, one week after it was posted.
    // greedy: D->A 417. Remaining debts (B -166, C -917, D -917) are the 2000 riding in the carry.
    assertSettlement('2026-11-02', la('2026-11-09', '12:00'), {
      live: { A: 417, B: -166, C: -917, D: -1334 },
      billable: { A: 417, B: -166, C: -917, D: -1334 },
      obligations: ['D->A:417'],
      carry: 2000,
    });
    settleUp('2026-11-02', la('2026-11-09', '13:00'), la('2026-11-09', '14:00'));

    // DST: generated UTC instants follow local 08:00/09:00 across the fall-back.
    after(la('2026-11-02', '08:00'), 'DST instants', async () => {
      const r = await rows<{ d: string; o: Date; dl: Date }>(
        db,
        `select to_char(local_date, 'YYYY-MM-DD') d, window_open_at o, deadline_at dl from public.pact_instances
          where pact_id = $1 and local_date in ('2026-10-30', '2026-11-02') order by 1`,
        [pact],
      );
      expect.soft(r.map((x) => [x.d, x.o.toISOString(), x.dl.toISOString()])).toEqual([
        ['2026-10-30', '2026-10-30T15:00:00.000Z', '2026-10-30T16:00:00.000Z'],
        ['2026-11-02', '2026-11-02T16:00:00.000Z', '2026-11-02T17:00:00.000Z'],
      ]);
    });

    const hot: [number, number][] = [
      ...PACT_DAYS.map((d): [number, number] => [la(d, '07:30'), la(d, '10:00')]),
      ...MONDAY_NOONS.map((t): [number, number] => [t - 30 * MIN, t + 30 * MIN]),
      [la('2026-11-01', '17:30'), la('2026-11-01', '19:30')],
      [la('2026-11-02', '12:00'), la('2026-11-02', '16:30')],
    ];
    const points = [
      ...PACT_DAYS.flatMap((d) => [la(d, '08:00'), la(d, '08:45'), la(d, '09:00')]),
      ...MONDAY_NOONS.flatMap((t) => [t - MIN, t]),
      ...['2026-11-01', '2026-11-08'].flatMap((d) => [la(d, '18:00'), la(d, '18:45'), la(d, '19:00')]),
    ];
    sim = await simulate(db, { from: START, to: END, hot, points, events });

    expect(sim.violations, 'ledger invariants after every tick').toEqual([]);
    expect(sim.ticks).toBeGreaterThan(500);
    expect(await invariants(db)).toEqual(ZERO_INVARIANTS);
  }, 600_000);

  it('final settlement: every obligation confirmed or superseded; balances are zero except money riding in the carry', async () => {
    const sets = await settlementsOf(db, groupId);
    expect(sets.map((s) => s.week_start)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02']);
    const statuses = async (sid: string) =>
      (await obligationsOf(db, sid)).map((o) => `${name(o.from_user)}->${name(o.to_user)}:${o.amount_cents}:${o.status}`).sort();
    expect(await statuses(sets[0].id)).toEqual(
      ['C->A:1292:confirmed', 'C->B:83:confirmed', 'D->B:209:confirmed', 'E->B:1000:superseded'].sort(),
    );
    expect(await statuses(sets[1].id)).toEqual(
      ['C->B:126:confirmed', 'E->A:876:confirmed', 'E->B:166:confirmed', 'E->D:958:confirmed'].sort(),
    );
    expect(await statuses(sets[2].id)).toEqual(['D->A:417:confirmed']);
    // one settlement_payment per confirmed obligation, for exactly its amount
    const payments = await rows<{ n: number; m: number }>(
      db,
      `select (select count(*)::int from public.ledger_entries where kind = 'settlement_payment' and group_id = $1) n,
              (select count(*)::int from public.obligations o where o.group_id = $1 and o.status = 'confirmed'
                 and exists (select 1 from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
                              join public.ledger_accounts a on a.id = l.account_id
                             where e.idempotency_key = 'payment:' || o.id and a.user_id = o.from_user and l.amount_cents = o.amount_cents)) m`,
      [groupId],
    );
    expect(payments).toEqual([{ n: 8, m: 8 }]);
    const open = await scalar<number>(
      db,
      `select count(*)::int from public.obligations where group_id = $1 and status in ('pending', 'marked_paid')`,
      [groupId],
    );
    expect(open).toBe(0);
    const bal = await balancesOf(db, groupId);
    const carry = await carryOf(db, groupId);
    expect(carry).toBe(2000);
    expect(Object.values(bal).reduce((a, b) => a + b, 0)).toBe(-carry);
    // Remaining debts are exactly what still rides in the carry: nobody is owed anything.
    expect(Object.values(bal).every((b) => b <= 0)).toBe(true);
    expect(byName(bal)).toEqual({ B: -166, C: -917, D: -917 });
    expect(byName(await billableOf(db, groupId))).toEqual({ B: -166, C: -917, D: -917 });
    // Each week's obligations total the positive settlement input (billable, marked_paid counted as paid).
    for (const s of sets) {
      const m = settlementMoments[s.week_start];
      const owed = (await obligationsOf(db, s.id)).reduce((a, o) => a + Number(o.amount_cents), 0);
      expect(owed, s.week_start).toBe(Object.values(m.input).filter((b) => b > 0).reduce((a, b) => a + b, 0));
    }
  });

  it('outbox has the expected kinds with no duplicates per (user, instance, kind)', async () => {
    const kinds = await rows<{ kind: string }>(db, `select distinct kind from public.notification_outbox order by kind`);
    expect(kinds.map((k) => k.kind)).toEqual([
      'deadline_soon', 'obligation_disputed', 'obligation_marked_paid', 'place_changed', 'result', 'review_opened', 'settlement', 'window_open',
    ]);
    // RT-3: every mark-paid went to its payee, the one dispute to its payer; nothing still marked paid is unannounced
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'obligation_disputed'`)).toBe(1);
    expect(
      await scalar<number>(
        db,
        `select count(*)::int from public.notification_outbox n join public.obligations o on o.id = (n.payload ->> 'obligation_id')::uuid
          where (n.kind = 'obligation_marked_paid' and n.user_id <> o.to_user) or (n.kind = 'obligation_disputed' and n.user_id <> o.from_user)`,
      ),
    ).toBe(0);
    expect(
      await scalar<number>(
        db,
        `select count(*)::int from public.obligations o
          where o.status = 'marked_paid'
            and not exists (select 1 from public.notification_outbox n where n.kind = 'obligation_marked_paid' and (n.payload ->> 'obligation_id')::uuid = o.id)`,
      ),
    ).toBe(0);

    const dups = await rows(
      db,
      `select user_id, kind, payload->>'instance_id' i, payload->>'correction' c, payload->>'review_id' r,
              payload->>'settlement_id' s, payload->>'place_id' p, payload->>'event' ev, payload->>'obligation_id' ob, count(*)::int n
         from public.notification_outbox
        group by 1, 2, 3, 4, 5, 6, 7, 8, 9 having count(*) > 1`,
    );
    expect(dups).toEqual([]);

    // window_open: exactly once per non-frozen participant of every instance that opened.
    const wo = await rows(
      db,
      `with expected as (
         select r.instance_id::text i, r.user_id::text u from public.results r where r.status <> 'frozen'
       ), got as (
         select payload->>'instance_id' i, user_id::text u from public.notification_outbox where kind = 'window_open'
       )
       select * from ((select * from expected except select * from got) union all (select * from got except select * from expected)) x`,
    );
    expect(wo, 'window_open recipients').toEqual([]);
    const frozenWindowOpen = await scalar<number>(
      db,
      `select count(*)::int from public.notification_outbox o join public.freezes f
          on f.instance_id::text = o.payload->>'instance_id' and f.user_id = o.user_id where o.kind = 'window_open'`,
    );
    expect(frozenWindowOpen).toBe(0);

    // deadline_soon: once per instance, to non-frozen participants with no in-fence check-in yet.
    const ds = await rows(
      db,
      `with expected as (
         select r.instance_id::text i, r.user_id::text u
           from public.results r join public.pact_instances pi on pi.id = r.instance_id
          where r.status <> 'frozen' and pi.deadline_soon_sent_at is not null
            and not exists (select 1 from public.checkins c where c.instance_id = r.instance_id and c.user_id = r.user_id
                              and c.verdict = 'in_fence' and c.server_received_at <= pi.deadline_soon_sent_at)
       ), got as (
         select payload->>'instance_id' i, user_id::text u from public.notification_outbox where kind = 'deadline_soon'
       )
       select * from ((select * from expected except select * from got) union all (select * from got except select * from expected)) x`,
    );
    expect(ds, 'deadline_soon recipients').toEqual([]);
    const instancesWithResults = await scalar<number>(db, `select count(distinct instance_id)::int from public.results`);
    expect(instancesWithResults).toBe(16); // 15 weekday instances + Sunday 11-01
    expect(
      await scalar<number>(db, `select count(*)::int from public.pact_instances where pact_id = $1 and deadline_soon_sent_at is not null`, [pact]),
    ).toBe(15);

    // result: exactly one closing notice per result row; corrections numbered per instance.
    const rs = await rows(
      db,
      `with expected as (select instance_id::text i, user_id::text u from public.results),
            got as (select payload->>'instance_id' i, user_id::text u from public.notification_outbox
                     where kind = 'result' and not payload ? 'correction')
       select * from ((select * from expected except select * from got) union all (select * from got except select * from expected)) x`,
    );
    expect(rs, 'result recipients').toEqual([]);
    const corrections = await rows<{ i: string; c: string; n: number }>(
      db,
      `select payload->>'instance_id' i, payload->>'correction' c, count(*)::int n from public.notification_outbox
        where kind = 'result' and payload ? 'correction' group by 1, 2 order by 1, 2`,
    );
    const correctionEntries = await rows<{ i: string; c: string }>(
      db,
      `select instance_id::text i, split_part(idempotency_key, ':', 3) c from public.ledger_entries where kind = 'correction' order by 1, 2`,
    );
    expect(corrections.map((c) => `${c.i}:${c.c}`)).toEqual(correctionEntries.map((c) => `${c.i}:${c.c}`));
    // Thu 10-22 (late check-in), Fri 10-23 (appeal), Tue 10-27 (challenge), Sun 11-01 (late check-in
    // after settlement). Wed 10-28's defaulted appeal leaves the result standing: no correction (N3-1).
    expect(correctionEntries).toHaveLength(4);

    // review_opened: every other current participant, once per review.
    for (const [key, rid] of Object.entries(reviewIds)) {
      const got = await rows<{ user_id: string }>(
        db,
        `select user_id::text from public.notification_outbox where kind = 'review_opened' and payload->>'review_id' = $1`,
        [rid],
      );
      expect(got.map((g) => name(g.user_id)).sort(), `review_opened ${key}`).toEqual(reviewRecipients[key]);
    }
    expect(Object.keys(reviewIds)).toHaveLength(4);

    // settlement: once per (user, settlement); week 2 still reaches E (left, but owed money); week 3 does not.
    const sets = await settlementsOf(db, groupId);
    const perSettlement: string[][] = [];
    for (const s of sets) {
      const r = await rows<{ user_id: string }>(
        db,
        `select user_id::text from public.notification_outbox where kind = 'settlement' and payload->>'settlement_id' = $1`,
        [s.id],
      );
      perSettlement.push(r.map((x) => name(x.user_id)).sort());
    }
    expect(perSettlement).toEqual([
      ['A', 'B', 'C', 'D', 'E'],
      ['A', 'B', 'C', 'D', 'E'],
      ['A', 'B', 'C', 'D'],
    ]);
  });

  it('re-running every cron job at the end changes nothing', async () => {
    const snap = await snapshot(db, null);
    for (const t of [END, END + 30 * MIN, END + 45 * MIN]) await runCrons(db, iso(t));
    expect(await snapshot(db, null)).toEqual(snap);
    expect(await invariants(db)).toEqual(ZERO_INVARIANTS);
  });

  it('purge_old_locations nulls coordinates older than 30 days and keeps verdicts and money', async () => {
    const money = await snapshot(db, null, { withCoords: false });
    const withCoords = await scalar<number>(db, `select count(*)::int from public.checkins where lat is not null`);
    expect(withCoords).toBeGreaterThan(40);

    // 2026-11-20: only Mon 10-19 and Tue 10-20 check-ins are older than 30 days.
    const purge = (t: string) => asService(db, (d) => scalar<number>(d, `select public.purge_old_locations($1::timestamptz)`, [t]));
    const oldOnes = await scalar<number>(
      db,
      `select count(*)::int from public.checkins where lat is not null and server_received_at < '2026-10-21T00:00:00Z'`,
    );
    expect(oldOnes).toBe(8); // Mon: 4 in-fence; Tue: 3 in + 1 out (E's no-fix had no coordinates)
    expect(await purge('2026-11-20T00:00:00Z')).toBe(oldOnes);
    expect(
      await scalar<number>(db, `select count(*)::int from public.checkins where lat is not null and server_received_at < '2026-10-21T00:00:00Z'`),
    ).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.checkins where lat is not null`)).toBe(withCoords - oldOnes);

    // 31 days after the last check-in (Fri 11-06): everything is purged.
    const lastCheckin = await scalar<Date>(db, `select max(server_received_at) from public.checkins`);
    const t31 = iso(lastCheckin.getTime() + 31 * 86_400_000);
    expect(await purge(t31)).toBe(withCoords - oldOnes);
    expect(await scalar<number>(db, `select count(*)::int from public.checkins where lat is not null or lng is not null`)).toBe(0);
    expect(await purge(t31)).toBe(0);
    // verdicts, distances, results, ledger, obligations untouched
    expect(await snapshot(db, null, { withCoords: false })).toEqual(money);
    expect(await scalar<number>(db, `select count(*)::int from public.checkins where distance_m is null and verdict <> 'unjudgeable'`)).toBe(0);
  });
});

// =============================================================================================
// Scenario B: New York and Kolkata groups running simultaneously; one person in both.
// =============================================================================================
describe('Scenario B: two groups in different settlement time zones', () => {
  let db: DB;
  const id = {} as Record<'X' | 'N1' | 'N2' | 'K1' | 'K2', string>;
  type U = keyof typeof id;
  let ny_g: string, kol_g: string, ny_p: string, kol_p: string;
  const nyPlace: Record<string, Place> = {};
  const kolPlace: Record<string, Place> = {};
  const name = (uid: string) => (Object.entries(id).find(([, v]) => v === uid)?.[0] ?? uid) as U;
  const byName = (rec: Record<string, number>) =>
    Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== 0).map(([k, v]) => [name(k), v]).sort());
  const exp = (rec: Partial<Record<U, number>>) => Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== 0).sort());

  beforeAll(async () => {
    db = await createDb();
    for (const u of ['X', 'N1', 'N2', 'K1', 'K2'] as U[]) id[u] = await createUser(db, `${u.toLowerCase()}@twocity.test`, u);
    ny_g = await asUser(db, id.X, (d) => scalar<string>(d, `select public.create_group('NYC', 'America/New_York')`));
    kol_g = await asUser(db, id.K1, (d) => scalar<string>(d, `select public.create_group('Kolkata', 'Asia/Kolkata')`));
    const code = (g: string) => scalar<string>(db, `select invite_code from public.groups where id = $1`, [g]);
    const nyCode = await code(ny_g);
    const kolCode = await code(kol_g);
    for (const u of ['N1', 'N2'] as U[]) await asUser(db, id[u], (d) => d.query(`select public.join_group($1)`, [nyCode]));
    for (const u of ['X', 'K2'] as U[]) await asUser(db, id[u], (d) => d.query(`select public.join_group($1)`, [kolCode]));
    ny_p = await asUser(db, id.X, (d) =>
      scalar<string>(d, `select public.create_pact($1, 'gym 7am', '{1,2,3,4,5}'::smallint[], '07:00', '08:00', 300, null)`, [ny_g]),
    );
    kol_p = await asUser(db, id.K1, (d) =>
      scalar<string>(d, `select public.create_pact($1, 'yoga 7am', '{1,2,3,4,5}'::smallint[], '07:00', '08:00', 700, null)`, [kol_g]),
    );
    for (const [i, u] of (['X', 'N1', 'N2'] as U[]).entries()) {
      nyPlace[u] = { lat: 40.7 + i * 0.01, lng: -74.0 };
      await asUser(db, id[u], (d) => d.query(`select public.join_pact($1, $2, $3, 100, 'gym')`, [ny_p, nyPlace[u].lat, nyPlace[u].lng]));
    }
    for (const [i, u] of (['X', 'K1', 'K2'] as U[]).entries()) {
      kolPlace[u] = { lat: 22.57 + i * 0.01, lng: 88.36 };
      await asUser(db, id[u], (d) => d.query(`select public.join_pact($1, $2, $3, 100, 'studio')`, [kol_p, kolPlace[u].lat, kolPlace[u].lng]));
    }
    // Both groups created at Monday 00:00 local of the simulated week.
    await db.query(`update public.groups set created_at = $2 where id = $1`, [ny_g, iso(ny('2026-11-02', '00:00'))]);
    await db.query(`update public.groups set created_at = $2 where id = $1`, [kol_g, iso(kol('2026-11-02', '00:00'))]);
    await db.query(`update public.pact_participants set joined_at = '2026-10-01T00:00:00Z'`);
    await db.query(`update public.group_members set joined_at = '2026-10-01T00:00:00Z'`);
  }, 120_000);

  it('each group settles at its own Monday noon and never touches the other group', async () => {
    const events: Ev[] = [];
    const before = (at: number, label: string, run: () => Promise<void>) => events.push({ at, label, phase: 'before', run });
    const after = (at: number, label: string, run: () => Promise<void>) => events.push({ at, label, phase: 'after', run });
    const DAYS = dateRange('2026-11-02', '2026-11-06');
    for (const [k, d] of DAYS.entries()) {
      // NY ($3): X every day; N1 Mon-Tue; N2 never.
      const nyCi = (u: U, hm: string) =>
        before(ny(d, hm), `NY ${u} ${d}`, async () => {
          await checkInAt(db, id[u], await instanceOf(db, ny_p, d), nyPlace[u], 'in', ny(d, hm));
        });
      nyCi('X', '07:05');
      if (k < 2) nyCi('N1', '07:10');
      // Kolkata ($7): K1 every day; X Monday only; K2 Wed-Fri.
      const kCi = (u: U, hm: string) =>
        before(kol(d, hm), `KOL ${u} ${d}`, async () => {
          await checkInAt(db, id[u], await instanceOf(db, kol_p, d), kolPlace[u], 'in', kol(d, hm));
        });
      kCi('K1', '07:05');
      if (k === 0) kCi('X', '07:10');
      if (k >= 2) kCi('K2', '07:15');
    }
    // Mon 11-09: nobody checks in anywhere -> both groups roll their stakes into their own carry.

    // NY:  Mon,Tue pot 300 -> X 150, N1 150, N2 -300; Wed-Fri X +600, N1 -300, N2 -300
    //      X 2100, N1 -600, N2 -1500
    // KOL: Mon X 350, K1 350, K2 -700; Tue K1 +1400, X -700, K2 -700; Wed-Fri K1 350, K2 350, X -700
    //      X -2450, K1 2800, K2 -350
    after(Date.parse('2026-11-07T12:00:00Z'), 'week balances', async () => {
      expect.soft(byName(await balancesOf(db, ny_g)), 'NY week').toEqual(exp({ X: 2100, N1: -600, N2: -1500 }));
      expect.soft(byName(await balancesOf(db, kol_g)), 'KOL week').toEqual(exp({ X: -2450, K1: 2800, K2: -350 }));
    });

    const KOL_NOON = kol('2026-11-09', '12:00'); // 06:30Z
    const NY_NOON = ny('2026-11-09', '12:00'); // 17:00Z
    expect(iso(KOL_NOON)).toBe('2026-11-09T06:30:00.000Z');
    expect(iso(NY_NOON)).toBe('2026-11-09T17:00:00.000Z');
    const weekSettled = async (g: string) => (await settlementsOf(db, g)).some((s) => s.week_start === '2026-11-02');
    let nySnap: any;
    let kolSnap: any;
    after(KOL_NOON - MIN, 'nobody settled at 06:29Z', async () => {
      expect.soft(await weekSettled(kol_g)).toBe(false);
      expect.soft(await weekSettled(ny_g)).toBe(false);
      nySnap = await snapshot(db, ny_g);
    });
    // Mon 11-09 instances close (all fail, stakes roll into the carry) before each noon settlement,
    // but they belong to the new week: they stay 'closed' and are not billed now.
    const settledObligations = async (g: string, input: Record<string, number>) => {
      const s = (await settlementsOf(db, g)).find((x) => x.week_start === '2026-11-02')!;
      const obs = (await obligationsOf(db, s.id)).map((o) => `${name(o.from_user)}->${name(o.to_user)}:${o.amount_cents}`).sort();
      const oracle = simplifyDebts(input).obligations.map((o) => `${name(o.from)}->${name(o.to)}:${o.amountCents}`).sort();
      expect.soft(obs, 'obligations vs simplifyDebts(billable adjusted for marked_paid)').toEqual(oracle);
      return obs;
    };
    const monStatus = (p: string) =>
      scalar<string>(db, `select status::text from public.pact_instances where pact_id = $1 and local_date = '2026-11-09'`, [p]);
    after(KOL_NOON, 'Kolkata settles at its noon; NY untouched', async () => {
      expect.soft(await weekSettled(kol_g), 'KOL settled').toBe(true);
      expect.soft(await weekSettled(ny_g), 'NY not yet').toBe(false);
      expect.soft(await snapshot(db, ny_g), 'NY untouched by KOL settlement').toEqual(nySnap);
      expect.soft(byName(await balancesOf(db, kol_g)), 'KOL live at settlement').toEqual(exp({ X: -3150, K1: 2100, K2: -1050 }));
      expect.soft(await carryOf(db, kol_g)).toBe(2100);
      expect.soft(await monStatus(kol_p), 'KOL Mon 11-09 closed, not settled').toBe('closed');
      const input = await settlementInputOf(db, kol_g);
      expect.soft(byName(input), 'KOL billed at settlement').toEqual(exp({ X: -2450, K1: 2800, K2: -350 }));
      expect.soft(await settledObligations(kol_g, input)).toEqual(['K2->K1:350', 'X->K1:2450']);
    });
    before(kol('2026-11-09', '13:00'), 'KOL payer marks paid', async () => {
      const s = (await settlementsOf(db, kol_g)).find((x) => x.week_start === '2026-11-02')!;
      await markAllPaid(db, s.id);
    });
    before(kol('2026-11-09', '13:15'), 'KOL payee confirms', async () => {
      const s = (await settlementsOf(db, kol_g)).find((x) => x.week_start === '2026-11-02')!;
      await confirmAll(db, s.id);
    });
    after(NY_NOON - MIN, 'NY not settled at 16:59Z', async () => {
      expect.soft(await weekSettled(ny_g)).toBe(false);
      kolSnap = await snapshot(db, kol_g);
    });
    after(NY_NOON, 'NY settles at its noon; Kolkata untouched', async () => {
      expect.soft(await weekSettled(ny_g), 'NY settled').toBe(true);
      expect.soft(await snapshot(db, kol_g), 'KOL untouched by NY settlement').toEqual(kolSnap);
      expect.soft(byName(await balancesOf(db, ny_g)), 'NY live at settlement').toEqual(exp({ X: 1800, N1: -900, N2: -1800 }));
      expect.soft(await carryOf(db, ny_g)).toBe(900);
      expect.soft(await monStatus(ny_p), 'NY Mon 11-09 closed, not settled').toBe('closed');
      const input = await settlementInputOf(db, ny_g);
      expect.soft(byName(input), 'NY billed at settlement').toEqual(exp({ X: 2100, N1: -600, N2: -1500 }));
      expect.soft(await settledObligations(ny_g, input)).toEqual(['N1->X:600', 'N2->X:1500']);
    });
    before(ny('2026-11-09', '13:00'), 'NY payer marks paid', async () => {
      const s = (await settlementsOf(db, ny_g)).find((x) => x.week_start === '2026-11-02')!;
      await markAllPaid(db, s.id);
    });
    before(ny('2026-11-09', '13:15'), 'NY payee confirms', async () => {
      const s = (await settlementsOf(db, ny_g)).find((x) => x.week_start === '2026-11-02')!;
      await confirmAll(db, s.id);
    });

    const hot: [number, number][] = [];
    const points: number[] = [];
    for (const d of dateRange('2026-11-02', '2026-11-09').filter((x) => isoDow(x) <= 5)) {
      for (const f of [ny, kol]) {
        hot.push([f(d, '06:30'), f(d, '09:00')]);
        points.push(f(d, '07:00'), f(d, '07:45'), f(d, '08:00'));
      }
    }
    for (const t of [KOL_NOON, NY_NOON]) {
      hot.push([t - 30 * MIN, t + 30 * MIN]);
      points.push(t - MIN, t);
    }
    const sim = await simulate(db, {
      from: Date.parse('2026-11-01T18:00:00Z'),
      to: ny('2026-11-09', '14:00'),
      hot,
      points,
      events,
    });
    expect(sim.violations, 'ledger invariants after every tick').toEqual([]);

    // Final: everything billed is paid; what's left is Mon 11-09's all-fail stakes (unbilled until
    // next week's settlement), which is exactly what rides in each group's carry.
    for (const [g, expected] of [
      [ny_g, exp({ X: -300, N1: -300, N2: -300 })],
      [kol_g, exp({ X: -700, K1: -700, K2: -700 })],
    ] as const) {
      const bal = await balancesOf(db, g);
      expect(byName(bal)).toEqual(expected);
      expect(Object.values(bal).reduce((a, b) => a + b, 0)).toBe(-(await carryOf(db, g)));
      expect(byName(await billableOf(db, g))).toEqual({});
    }
    // Exactly one settlement per group, for week 2026-11-02.
    expect((await settlementsOf(db, ny_g)).map((s) => s.week_start)).toEqual(['2026-11-02']);
    expect((await settlementsOf(db, kol_g)).map((s) => s.week_start)).toEqual(['2026-11-02']);

    // Isolation: accounts, obligations, outbox and per-pact carries belong to their own group.
    const crossAccounts = await scalar<number>(
      db,
      `select count(*)::int from public.ledger_accounts a
        where a.kind = 'member' and not exists (select 1 from public.group_members m where m.group_id = a.group_id and m.user_id = a.user_id)`,
    );
    expect(crossAccounts).toBe(0);
    const crossObligations = await scalar<number>(
      db,
      `select count(*)::int from public.obligations o
        where not exists (select 1 from public.group_members m where m.group_id = o.group_id and m.user_id = o.from_user)
           or not exists (select 1 from public.group_members m where m.group_id = o.group_id and m.user_id = o.to_user)`,
    );
    expect(crossObligations).toBe(0);
    const crossPot = await scalar<number>(
      db,
      `select count(*)::int from public.ledger_accounts a join public.pact_instances i on i.id = a.instance_id
         join public.pacts p on p.id = i.pact_id where a.kind = 'pot' and p.group_id <> a.group_id`,
    );
    expect(crossPot).toBe(0);
    const crossEntries = await scalar<number>(
      db,
      `select count(*)::int from public.ledger_entries e join public.pact_instances i on i.id = e.instance_id
         join public.pacts p on p.id = i.pact_id where p.group_id <> e.group_id`,
    );
    expect(crossEntries).toBe(0);
    const settlementNotes = await rows<{ g: string; u: string }>(
      db,
      `select o.payload->>'group_id' g, o.user_id::text u from public.notification_outbox o where kind = 'settlement' order by 1, 2`,
    );
    expect(settlementNotes.filter((n) => n.g === ny_g).map((n) => name(n.u)).sort()).toEqual(['N1', 'N2', 'X']);
    expect(settlementNotes.filter((n) => n.g === kol_g).map((n) => name(n.u)).sort()).toEqual(['K1', 'K2', 'X']);

    // RLS view through the client role: each person sees only their own groups' balances.
    const seen = async (u: U) =>
      (await asUser(db, id[u], (d) => rows<{ group_id: string }>(d, `select distinct group_id::text from public.member_balances`)))
        .map((r) => r.group_id)
        .sort();
    expect(await seen('N1')).toEqual([ny_g]);
    expect(await seen('K2')).toEqual([kol_g]);
    expect(await seen('X')).toEqual([ny_g, kol_g].sort());

    // Re-running the jobs changes neither group.
    const snapNy = await snapshot(db, ny_g);
    const snapKol = await snapshot(db, kol_g);
    await runCrons(db, iso(ny('2026-11-09', '14:00')));
    expect(await snapshot(db, ny_g)).toEqual(snapNy);
    expect(await snapshot(db, kol_g)).toEqual(snapKol);
  }, 600_000);
});
