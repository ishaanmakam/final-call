import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  asAnon,
  asService,
  asUser,
  createDb,
  createGroupFixture,
  createUser,
  expectError,
  rows,
  scalar,
  type DB,
  type GroupFixture,
  type PactSpec,
} from './helpers/db';

// Default fixture pact: Mon-Fri 08:00-09:00 America/Los_Angeles. January 2030 is PST (UTC-8).
// Monday 2030-01-07: window 16:00Z, deadline 17:00Z. Tuesday 2030-01-08: 16:00Z / 17:00Z.
const GEN_NOW = '2030-01-06T12:00:00Z'; // Sunday 04:00 LA
const MON = '2030-01-07';
const MON_OPEN = '2030-01-07T16:00:00.000Z';
const MON_DEADLINE = '2030-01-07T17:00:00.000Z';
const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();

async function setup(
  db: DB,
  opts: { members?: number; participants?: number; pact?: PactSpec } = {},
): Promise<GroupFixture & { pactId: string }> {
  const fx = await createGroupFixture(db, { members: opts.members ?? 3, participants: opts.participants, pact: opts.pact });
  // Fixture joins happen at wall-clock now(); backdate so they predate every simulated window.
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  return fx as GroupFixture & { pactId: string };
}

async function installSpies(db: DB) {
  await db.exec(`
    create table public._spy (n serial, fn text, instance_id uuid);
    create or replace function public.post_instance_payout(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
      as $$ begin insert into public._spy (fn, instance_id) values ('payout', p_instance); end $$;
    create or replace function public.apply_instance_correction(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
      as $$ begin insert into public._spy (fn, instance_id) values ('correction', p_instance); end $$;
  `);
}
const spyCalls = (db: DB, fn: string, instance: string) =>
  scalar<number>(db, `select count(*)::int from public._spy where fn = $1 and instance_id = $2`, [fn, instance]);

const gen = (db: DB, now = GEN_NOW, days = 7) =>
  scalar<number>(db, `select public.generate_instances($1, $2::timestamptz)`, [days, now]);
const tick = (db: DB, now: string) => db.query(`select public.tick_instances($1::timestamptz)`, [now]);
const instanceId = (db: DB, pactId: string, date: string) =>
  scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);

interface Fix {
  lat?: number | null;
  lng?: number | null;
  acc?: number | null;
  captured?: string;
  sim?: boolean;
  attempt?: string | null;
}
// participant i's place: lat 47.6553 + i*0.01, lng -122.3035, radius 100 m
const placeOf = (i: number) => ({ lat: 47.6553 + i * 0.01, lng: -122.3035 });
const inFence = (i: number): Fix => ({ ...placeOf(i), acc: 10 });
const outFence = (i: number): Fix => ({ lat: placeOf(i).lat + 0.01, lng: placeOf(i).lng, acc: 10 });

async function checkInAt(db: DB, user: string, instance: string, fix: Fix, now: string) {
  const r = await db.query<any>(
    `select * from public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz)`,
    [
      user,
      instance,
      fix.lat === undefined ? null : fix.lat,
      fix.lng === undefined ? null : fix.lng,
      fix.acc === undefined ? null : fix.acc,
      fix.captured ?? now,
      fix.sim ?? false,
      fix.attempt ?? null,
      now,
    ],
  );
  return r.rows[0];
}

const resultsOf = async (db: DB, instance: string) =>
  Object.fromEntries(
    (
      await rows<{ user_id: string; status: string; first_success_at: Date | null }>(
        db,
        `select user_id, status::text, first_success_at from public.results where instance_id = $1`,
        [instance],
      )
    ).map((r) => [r.user_id, { status: r.status, first: r.first_success_at?.toISOString() ?? null }]),
  );

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

// ---------------------------------------------------------------------------------------------
describe('generate_instances', () => {
  it('creates one instance per scheduled local date with DST-free UTC times, idempotently', async () => {
    const fx = await setup(db);
    expect(await gen(db)).toBe(5); // Sun 2030-01-06 .. Sun 2030-01-13 -> Mon..Fri
    const inst = await rows<{ local_date: string; o: string; d: string; status: string }>(
      db,
      `select to_char(local_date, 'YYYY-MM-DD') local_date, window_open_at o, deadline_at d, status::text
         from public.pact_instances where pact_id = $1 order by local_date`,
      [fx.pactId],
    );
    expect(inst.map((i) => i.local_date)).toEqual(['2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10', '2030-01-11']);
    expect(new Date(inst[0].o).toISOString()).toBe(MON_OPEN);
    expect(new Date(inst[0].d).toISOString()).toBe(MON_DEADLINE);
    expect(inst.every((i) => i.status === 'scheduled')).toBe(true);
    expect(await gen(db)).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.pact_instances`)).toBe(5);
    // horizon grows by one day: Monday 2030-01-14 appears
    expect(await gen(db, '2030-01-07T12:00:00Z')).toBe(1);
  });

  it('skips paused pacts and instances whose window already opened', async () => {
    const fx = await setup(db);
    const paused = await asUser(db, fx.ownerId, (d) =>
      scalar<string>(d, `select public.create_pact($1, 'paused', '{1,2,3,4,5,6,7}', '08:00', '09:00', 500, null)`, [fx.groupId]),
    );
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [paused]));
    // Monday 08:30 LA: Monday's window (08:00) is in the past
    expect(await gen(db, '2030-01-07T16:30:00Z', 0)).toBe(0);
    expect(await gen(db, '2030-01-07T16:30:00Z', 1)).toBe(1);
    expect(await rows(db, `select to_char(local_date, 'YYYY-MM-DD') d from public.pact_instances`)).toEqual([{ d: '2030-01-08' }]);
  });

  it('local date "today" follows the pact time zone, not UTC', async () => {
    const fx = await setup(db, { pact: { days: [7], tz: 'Pacific/Auckland' } });
    // 2030-01-05T12:00Z is Sunday 2030-01-06 01:00 in Auckland (UTC+13)
    expect(await gen(db, '2030-01-05T12:00:00Z', 0)).toBe(1);
    const r = await rows<{ d: string; o: Date }>(db, `select to_char(local_date,'YYYY-MM-DD') d, window_open_at o from public.pact_instances where pact_id = $1`, [fx.pactId]);
    expect(r[0].d).toBe('2030-01-06');
    expect(r[0].o.toISOString()).toBe('2030-01-05T19:00:00.000Z'); // 08:00 NZDT
  });

  it('spring forward (America/Los_Angeles 2027-03-14): nonexistent times shift forward by the gap', async () => {
    const fx = await setup(db, { pact: { days: [7], windowOpen: '08:00', deadline: '09:00' } });
    const mk = (title: string, open: string, deadline: string) =>
      asUser(db, fx.ownerId, (d) =>
        scalar<string>(d, `select public.create_pact($1, $2, '{7}', $3::time, $4::time, 500, 'America/Los_Angeles')`, [fx.groupId, title, open, deadline]),
      );
    const a = await mk('a', '01:30', '02:30'); // open before gap, deadline in gap
    const b = await mk('b', '02:15', '02:45'); // whole window in gap
    const c = await mk('c', '02:30', '03:00'); // shifted open would be after deadline: keep duration
    expect(await gen(db, '2027-03-13T12:00:00Z', 2)).toBe(4);
    const get = async (p: string) => {
      const r = await rows<{ o: Date; d: Date }>(db, `select window_open_at o, deadline_at d from public.pact_instances where pact_id = $1 and local_date = '2027-03-14'`, [p]);
      return [r[0].o.toISOString(), r[0].d.toISOString()];
    };
    expect(await get(fx.pactId)).toEqual(['2027-03-14T15:00:00.000Z', '2027-03-14T16:00:00.000Z']); // PDT
    expect(await get(a)).toEqual(['2027-03-14T09:30:00.000Z', '2027-03-14T10:30:00.000Z']); // 01:30 PST, 03:30 PDT
    expect(await get(b)).toEqual(['2027-03-14T10:15:00.000Z', '2027-03-14T10:45:00.000Z']); // 03:15, 03:45 PDT
    expect(await get(c)).toEqual(['2027-03-14T09:30:00.000Z', '2027-03-14T10:00:00.000Z']); // deadline 03:00 PDT, 30 min window
  });

  it('fall back (America/Los_Angeles 2026-11-01): ambiguous times resolve to the earlier instant', async () => {
    const fx = await setup(db, { pact: { days: [7], windowOpen: '08:00', deadline: '09:00' } });
    const mk = (title: string, open: string, deadline: string) =>
      asUser(db, fx.ownerId, (d) =>
        scalar<string>(d, `select public.create_pact($1, $2, '{7}', $3::time, $4::time, 500, 'America/Los_Angeles')`, [fx.groupId, title, open, deadline]),
      );
    const a = await mk('a', '01:00', '01:30'); // both ambiguous
    const b = await mk('b', '00:30', '01:30');
    const c = await mk('c', '01:30', '02:00'); // 02:00 exists once (PST)
    expect(await gen(db, '2026-10-31T12:00:00Z', 2)).toBe(4);
    const get = async (p: string) => {
      const r = await rows<{ o: Date; d: Date }>(db, `select window_open_at o, deadline_at d from public.pact_instances where pact_id = $1 and local_date = '2026-11-01'`, [p]);
      return [r[0].o.toISOString(), r[0].d.toISOString()];
    };
    expect(await get(fx.pactId)).toEqual(['2026-11-01T16:00:00.000Z', '2026-11-01T17:00:00.000Z']); // PST
    expect(await get(a)).toEqual(['2026-11-01T08:00:00.000Z', '2026-11-01T08:30:00.000Z']); // PDT
    expect(await get(b)).toEqual(['2026-11-01T07:30:00.000Z', '2026-11-01T08:30:00.000Z']);
    expect(await get(c)).toEqual(['2026-11-01T08:30:00.000Z', '2026-11-01T10:00:00.000Z']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('tick_instances', () => {
  it('opens due instances once and enqueues window_open for each current participant', async () => {
    const fx = await setup(db, { members: 4, participants: 3 });
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, at(MON_OPEN, -1));
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [mon])).toBe('scheduled');
    await tick(db, MON_OPEN);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [mon])).toBe('open');
    expect(await scalar<number>(db, `select count(*)::int from public.pact_instances where status = 'open'`)).toBe(1);
    await tick(db, at(MON_OPEN, 1));
    const out = await rows<{ user_id: string; payload: any }>(db, `select user_id, payload from public.notification_outbox where kind = 'window_open'`);
    expect(out.map((o) => o.user_id).sort()).toEqual([...fx.participantIds].sort());
    expect(out[0].payload).toMatchObject({
      instance_id: mon,
      pact_id: fx.pactId,
      group_id: fx.groupId,
      pact_title: '9am class',
      deadline_local: '09:00:00',
      tz: 'America/Los_Angeles',
      stake_cents: 500,
    });
    expect(new Date(out[0].payload.deadline_at).toISOString()).toBe(MON_DEADLINE);
    expect(out.find((o) => o.user_id === fx.participantIds[1])!.payload.place_label).toBe('place 1');
  });

  it('enqueues deadline_soon once, 15 minutes before the deadline, only for participants without a success', async () => {
    const fx = await setup(db);
    const [a, b, c] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 5));
    await checkInAt(db, b, mon, outFence(1), at(MON_OPEN, 5));
    await tick(db, at(MON_DEADLINE, -16));
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'deadline_soon'`)).toBe(0);
    await tick(db, at(MON_DEADLINE, -15));
    await tick(db, at(MON_DEADLINE, -10));
    await tick(db, at(MON_DEADLINE, -1));
    const soon = await rows<{ user_id: string; payload: any }>(db, `select user_id, payload from public.notification_outbox where kind = 'deadline_soon'`);
    expect(soon.map((s) => s.user_id).sort()).toEqual([b, c].sort());
    expect(soon[0].payload).toMatchObject({ instance_id: mon, pact_id: fx.pactId, group_id: fx.groupId, pact_title: '9am class', stake_cents: 500 });
    expect(new Date(soon[0].payload.deadline_at).toISOString()).toBe(MON_DEADLINE);
  });

  it('closes at the deadline: success / failed / unverified, payout once, result outbox, re-run is a no-op', async () => {
    const fx = await setup(db, { members: 5 });
    await installSpies(db);
    const [a, b, c, d, e] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    await checkInAt(db, a, mon, outFence(0), at(MON_OPEN, 1));
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 10)); // first in-fence
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 20));
    await checkInAt(db, b, mon, outFence(1), at(MON_OPEN, 30)); // only out of fence -> failed
    await checkInAt(db, c, mon, { ...inFence(2), acc: 250 }, at(MON_OPEN, 30)); // unjudgeable -> unverified
    await checkInAt(db, d, mon, { ...inFence(3), sim: true }, at(MON_OPEN, 30)); // simulated -> failed
    await checkInAt(db, e, mon, inFence(4), MON_DEADLINE); // exactly at the deadline counts
    await tick(db, at(MON_DEADLINE, -1));
    expect(await scalar(db, `select count(*)::int from public.results`)).toBe(0);
    await tick(db, MON_DEADLINE);
    expect(await rows(db, `select status::text, closed_at from public.pact_instances where id = $1`, [mon])).toEqual([
      { status: 'closed', closed_at: new Date(MON_DEADLINE) },
    ]);
    expect(await resultsOf(db, mon)).toEqual({
      [a]: { status: 'success', first: at(MON_OPEN, 10) },
      [b]: { status: 'failed', first: null },
      [c]: { status: 'unverified', first: null },
      [d]: { status: 'failed', first: null },
      [e]: { status: 'success', first: MON_DEADLINE },
    });
    expect(await spyCalls(db, 'payout', mon)).toBe(1);
    const res = await rows<{ user_id: string; payload: any }>(db, `select user_id, payload from public.notification_outbox where kind = 'result'`);
    expect(res.length).toBe(5);
    expect(res.find((r) => r.user_id === a)!.payload).toMatchObject({
      status: 'success', pact_title: '9am class', stake_cents: 500, instance_id: mon, pact_id: fx.pactId, group_id: fx.groupId, rolled_over: false,
    });
    expect(typeof res[0].payload.net_cents).toBe('number');
    const before = await scalar<number>(db, `select count(*)::int from public.notification_outbox`);
    await tick(db, MON_DEADLINE);
    await tick(db, at(MON_DEADLINE, 5));
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox`)).toBe(before);
    expect(await spyCalls(db, 'payout', mon)).toBe(1);
  });

  it('all-fail instance is closed (not void) and flagged rolled_over', async () => {
    const fx = await setup(db);
    await installSpies(db);
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    await tick(db, MON_DEADLINE);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [mon])).toBe('closed');
    expect(Object.values(await resultsOf(db, mon)).map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    const p = await rows<{ payload: any }>(db, `select payload from public.notification_outbox where kind = 'result'`);
    expect(p.every((r) => r.payload.rolled_over === true && r.payload.status === 'failed')).toBe(true);
  });

  it('void rule: fewer than 2 active participants voids the instance; frozen stays frozen; no payout', async () => {
    const fx = await setup(db, { members: 4 });
    await installSpies(db);
    const [a, b, c, d] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [d, mon, at(MON_OPEN, -60)]);
    await tick(db, MON_OPEN);
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 5));
    await checkInAt(db, b, mon, { lat: null, lng: null, acc: null }, at(MON_OPEN, 5));
    await checkInAt(db, c, mon, { ...inFence(2), acc: 201 }, at(MON_OPEN, 5));
    await tick(db, MON_DEADLINE);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [mon])).toBe('voided');
    expect(await resultsOf(db, mon)).toEqual({
      [a]: { status: 'void', first: null },
      [b]: { status: 'void', first: null },
      [c]: { status: 'void', first: null },
      [d]: { status: 'frozen', first: null },
    });
    expect(await spyCalls(db, 'payout', mon)).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'result'`)).toBe(4);
  });

  it('results cover only participants who joined before the window and have not left', async () => {
    const fx = await setup(db, { members: 4 });
    const [a, b, c, d] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await db.query(`update public.pact_participants set joined_at = $3 where pact_id = $1 and user_id = $2`, [fx.pactId, c, at(MON_OPEN, 1)]);
    await asUser(db, d, (x) => x.query(`select public.leave_group($1)`, [fx.groupId]));
    await tick(db, MON_OPEN);
    expect((await rows(db, `select user_id from public.notification_outbox where kind = 'window_open'`)).map((r: any) => r.user_id).sort()).toEqual([a, b].sort());
    await tick(db, MON_DEADLINE);
    expect(Object.keys(await resultsOf(db, mon)).sort()).toEqual([a, b].sort());
  });

  it('paused pacts: future scheduled instances become voided with no results; resuming revives them', async () => {
    const fx = await setup(db);
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    const tue = await instanceId(db, fx.pactId, '2030-01-08');
    await tick(db, MON_OPEN);
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [fx.pactId]));
    await tick(db, at(MON_OPEN, 1));
    const st = await rows<{ local_date: string; status: string }>(
      db, `select to_char(local_date,'YYYY-MM-DD') local_date, status::text from public.pact_instances where pact_id = $1 order by local_date`, [fx.pactId]);
    expect(st[0]).toEqual({ local_date: MON, status: 'open' }); // already open: runs to completion
    expect(st.slice(1).every((s) => s.status === 'voided')).toBe(true);
    expect(await scalar(db, `select count(*)::int from public.results`)).toBe(0);
    await tick(db, '2030-01-08T16:00:00Z');
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [tue])).toBe('voided');
    expect(await scalar(db, `select count(*)::int from public.results where instance_id = $1`, [tue])).toBe(0);
    expect(await scalar(db, `select count(*)::int from public.results where instance_id = $1`, [mon])).toBe(3);
    // resume on Tuesday 09:00 LA: Wednesday onward comes back, Tuesday stays voided
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, false)`, [fx.pactId]));
    expect(await gen(db, '2030-01-08T17:00:00Z', 7)).toBeGreaterThanOrEqual(3);
    const after = await rows<{ local_date: string; status: string }>(
      db, `select to_char(local_date,'YYYY-MM-DD') local_date, status::text from public.pact_instances where pact_id = $1 order by local_date`, [fx.pactId]);
    expect(after.find((s) => s.local_date === '2030-01-08')!.status).toBe('voided');
    expect(after.filter((s) => s.local_date > '2030-01-08').every((s) => s.status === 'scheduled')).toBe(true);
  });

  it('an instance whose whole window passed while ticks were missed opens and closes in one tick without window_open spam', async () => {
    const fx = await setup(db);
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, at(MON_DEADLINE, 30));
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [mon])).toBe('closed');
    expect(await scalar(db, `select count(*)::int from public.notification_outbox where kind in ('window_open','deadline_soon')`)).toBe(0);
    expect(await scalar(db, `select count(*)::int from public.results where instance_id = $1`, [mon])).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
describe('check_in', () => {
  async function liveInstance(fx: { pactId: string }) {
    // window open in real time, so the client RPC (which uses now()) accepts it
    return scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
       values ($1, '2099-01-01', now() - interval '10 minutes', now() + interval '50 minutes', 'open') returning id`,
      [fx.pactId],
    );
  }
  const rpc = (d: DB, inst: string, lat: number | null, lng: number | null, acc: number | null, captured: string, sim = false, attempt: string | null = null) =>
    d.query<any>(`select * from public.check_in($1, $2, $3, $4, $5::timestamptz, $6, $7)`, [inst, lat, lng, acc, captured, sim, attempt]);

  it('client RPC computes the verdict and distance with server time', async () => {
    const fx = await setup(db);
    const inst = await liveInstance(fx);
    const [a] = fx.participantIds;
    const r = (await asUser(db, a, (d) => rpc(d, inst, placeOf(0).lat, placeOf(0).lng, 15, new Date().toISOString()))).rows[0];
    expect(r).toMatchObject({ instance_id: inst, user_id: a, verdict: 'in_fence', is_simulated: false });
    expect(r.distance_m).toBeCloseTo(0, 6);
    // the 6-argument contract signature still works
    const r6 = await asUser(db, a, (d) =>
      d.query<any>(`select verdict from public.check_in($1, $2, $3, $4, $5::timestamptz, $6)`, [inst, placeOf(0).lat + 0.01, placeOf(0).lng, 15, new Date().toISOString(), false]),
    );
    expect(r6.rows[0].verdict).toBe('out_of_fence');
  });

  it('verdicts: accuracy limits, uncertainty overlap, simulated, no fix', async () => {
    const fx = await setup(db);
    await gen(db);
    await tick(db, MON_OPEN);
    const mon = await instanceId(db, fx.pactId, MON);
    const [a] = fx.participantIds;
    const p = placeOf(0);
    const t = at(MON_OPEN, 5);
    const dLat = (m: number) => m / 111194.92664455873; // metres north along a meridian (R = 6371008.8)
    const cases: [Fix, string][] = [
      [{ lat: p.lat + dLat(150), lng: p.lng, acc: 60 }, 'in_fence'], // 150 - 60 = 90 <= 100
      [{ lat: p.lat + dLat(150), lng: p.lng, acc: 40 }, 'out_of_fence'], // 110 > 100
      [{ lat: p.lat + dLat(299), lng: p.lng, acc: 200 }, 'in_fence'], // accuracy 200 is still judged
      [{ lat: p.lat + dLat(301), lng: p.lng, acc: 200 }, 'out_of_fence'],
      [{ lat: p.lat, lng: p.lng, acc: 200.0001 }, 'unjudgeable'],
      [{ lat: p.lat, lng: p.lng, acc: -1 }, 'unjudgeable'],
      [{ lat: p.lat, lng: p.lng, acc: null }, 'unjudgeable'],
      [{ lat: null, lng: null, acc: null }, 'unjudgeable'], // phone got no fix
      [{ lat: null, lng: null, acc: 5 }, 'unjudgeable'],
      [{ lat: p.lat, lng: p.lng, acc: 5, sim: true }, 'rejected_simulated'],
    ];
    for (const [fix, verdict] of cases) {
      const r = await checkInAt(db, a, mon, fix, t);
      expect(r.verdict, JSON.stringify(fix)).toBe(verdict);
      expect(new Date(r.server_received_at).toISOString()).toBe(t);
    }
    const noFix = await rows<any>(db, `select distance_m from public.checkins where lat is null`);
    expect(noFix.every((r) => r.distance_m === null)).toBe(true);
    const d150 = await scalar<number>(db, `select distance_m from public.checkins where accuracy_m = 60`);
    expect(d150).toBeCloseTo(150, 3);
    await expectError(checkInAt(db, a, mon, { lat: 91, lng: 0, acc: 5 }, t), /lat/);
  });

  it('retries with the same client_attempt_id return the original row unchanged', async () => {
    const fx = await setup(db);
    const inst = await liveInstance(fx);
    const [a, b] = fx.participantIds;
    const attempt = '5f0e4c1e-0000-4000-8000-000000000001';
    const now = new Date().toISOString();
    const first = (await asUser(db, a, (d) => rpc(d, inst, placeOf(0).lat, placeOf(0).lng, 10, now, false, attempt))).rows[0];
    const again = (await asUser(db, a, (d) => rpc(d, inst, placeOf(0).lat + 1, placeOf(0).lng, 10, now, false, attempt))).rows[0];
    expect(again).toEqual(first);
    expect(await scalar(db, `select count(*)::int from public.checkins`)).toBe(1);
    // same attempt id from another user is a different attempt
    await asUser(db, b, (d) => rpc(d, inst, placeOf(1).lat, placeOf(1).lng, 10, now, false, attempt));
    expect(await scalar(db, `select count(*)::int from public.checkins`)).toBe(2);
    // and through the internal function, even after the window closed, the stored row comes back
    const late = await checkInAt(db, a, inst, { ...inFence(0), attempt }, '2099-12-31T00:00:00Z');
    expect(late.id).toBe(first.id);
  });

  it('rejects non-participants, outsiders, anon and direct table writes', async () => {
    const fx = await setup(db, { members: 4, participants: 3 });
    const inst = await liveInstance(fx);
    const now = new Date().toISOString();
    const memberNotInPact = fx.userIds[3];
    const outsider = await createUser(db);
    for (const u of [memberNotInPact, outsider]) {
      const e = await asUser(db, u, (d) => expectError(rpc(d, inst, 47.6, -122.3, 10, now)));
      expect(e.code).toBe('42501');
    }
    await asUser(db, fx.participantIds[2], (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    expect((await asUser(db, fx.participantIds[2], (d) => expectError(rpc(d, inst, 47.6, -122.3, 10, now)))).code).toBe('42501');
    await asAnon(db, (d) => expectError(rpc(d, inst, 47.6, -122.3, 10, now), /permission denied/));
    await asUser(db, fx.participantIds[0], (d) =>
      expectError(
        d.query(`insert into public.checkins (instance_id, user_id, verdict) values ($1, $2, 'in_fence')`, [inst, fx.participantIds[0]]),
        /permission denied/,
      ),
    );
    await asUser(db, fx.participantIds[0], (d) =>
      expectError(d.query(`select public.check_in_at($1, $2, 1, 1, 1, now(), false, null, now())`, [fx.participantIds[0], inst]), /permission denied/),
    );
    expect(await asUser(db, fx.participantIds[0], (d) => expectError(d.query(`select public.check_in(gen_random_uuid(), 1, 1, 1, now(), false)`)))).toMatchObject({ code: 'P0002' });
  });

  it('timing: before the window, future client clocks, and captures after the deadline are rejected', async () => {
    const fx = await setup(db);
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    const [a] = fx.participantIds;
    expect((await expectError(checkInAt(db, a, mon, inFence(0), at(MON_OPEN, -1)))).code).toBe('23514');
    await tick(db, MON_OPEN);
    const t = at(MON_OPEN, 10);
    expect((await expectError(checkInAt(db, a, mon, { ...inFence(0), captured: at(t, 2.01) }, t))).code).toBe('22023');
    expect((await checkInAt(db, a, mon, { ...inFence(0), captured: at(t, 2) }, t)).verdict).toBe('in_fence');
    // after the deadline: the fix must have been captured inside the window
    expect((await expectError(checkInAt(db, a, mon, { ...inFence(0), captured: at(MON_DEADLINE, 1) }, at(MON_DEADLINE, 2)))).code).toBe('23514');
    expect((await expectError(checkInAt(db, a, mon, { ...inFence(0), captured: at(MON_OPEN, -1) }, at(MON_DEADLINE, 2)))).code).toBe('23514');
    expect((await checkInAt(db, a, mon, { ...inFence(0), captured: MON_DEADLINE }, at(MON_DEADLINE, 2))).verdict).toBe('in_fence');
  });

  it('late offline check-in after close: failed becomes unverified (with a correction); success stays success', async () => {
    const fx = await setup(db, { members: 4 });
    await installSpies(db);
    const [a, b, c, d] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 5));
    await checkInAt(db, b, mon, inFence(1), at(MON_OPEN, 6));
    await tick(db, MON_DEADLINE);
    expect((await resultsOf(db, mon))[c].status).toBe('failed');
    // c's phone captured an in-fence fix at 08:50 but was offline until 09:20
    const late = await checkInAt(db, c, mon, { ...inFence(2), captured: at(MON_DEADLINE, -10) }, at(MON_DEADLINE, 20));
    expect(late.verdict).toBe('in_fence');
    const r = await resultsOf(db, mon);
    expect(r[c]).toEqual({ status: 'unverified', first: null });
    expect(await spyCalls(db, 'correction', mon)).toBe(1);
    // a (already success) sends a late one too: unchanged, no correction
    await checkInAt(db, a, mon, { ...outFence(0), captured: at(MON_DEADLINE, -1) }, at(MON_DEADLINE, 21));
    expect((await resultsOf(db, mon))[a]).toEqual({ status: 'success', first: at(MON_OPEN, 5) });
    expect(await spyCalls(db, 'correction', mon)).toBe(1);
    // settled instances accept nothing
    await db.query(`update public.pact_instances set status = 'settled' where id = $1`, [mon]);
    expect((await expectError(checkInAt(db, d, mon, { ...inFence(3), captured: at(MON_DEADLINE, -1) }, at(MON_DEADLINE, 30)))).code).toBe('23514');
  });

  it('late check-in arriving before the close tick is counted as unverified when the instance closes', async () => {
    const fx = await setup(db);
    const [a, b, c] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 5));
    await checkInAt(db, b, mon, outFence(1), at(MON_OPEN, 5));
    await checkInAt(db, c, mon, { ...inFence(2), captured: at(MON_DEADLINE, -2) }, at(MON_DEADLINE, 0.5)); // cron lag
    await tick(db, at(MON_DEADLINE, 1));
    const r = await resultsOf(db, mon);
    expect([r[a].status, r[b].status, r[c].status]).toEqual(['success', 'failed', 'unverified']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('declare_freeze', () => {
  const freeze = (user: string, inst: string, now: string) =>
    scalar<string>(db, `select public.declare_freeze_at($1, $2, $3::timestamptz)`, [user, inst, now]);

  it('must be declared before the window opens; produces a frozen result', async () => {
    const fx = await setup(db);
    const [a, b, c] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    expect((await expectError(freeze(a, mon, MON_OPEN))).code).toBe('23514');
    const id = await freeze(b, mon, at(MON_OPEN, -1));
    expect(await rows(db, `select pact_id, user_id, instance_id, iso_week from public.freezes where id = $1`, [id])).toEqual([
      { pact_id: fx.pactId, user_id: b, instance_id: mon, iso_week: '2030-W02' },
    ]);
    await tick(db, MON_OPEN);
    expect((await expectError(freeze(c, mon, at(MON_OPEN, 1)))).code).toBe('23514');
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 1));
    await tick(db, at(MON_DEADLINE, -15));
    expect((await rows(db, `select user_id from public.notification_outbox where kind = 'deadline_soon'`)).map((r: any) => r.user_id)).toEqual([c]);
    await tick(db, MON_DEADLINE);
    const r = await resultsOf(db, mon);
    expect([r[a].status, r[b].status, r[c].status]).toEqual(['success', 'frozen', 'failed']);
  });

  it('one freeze per pact, user and ISO week of the local date', async () => {
    const fx = await setup(db, { pact: { days: [1, 2, 3, 4, 5, 6, 7] } });
    const [a, b] = fx.participantIds;
    await gen(db, GEN_NOW, 8); // Sun 2030-01-06 (ISO week 1) .. Mon 2030-01-14 (week 3)
    const sun = await instanceId(db, fx.pactId, '2030-01-06');
    const mon = await instanceId(db, fx.pactId, '2030-01-07');
    const tue = await instanceId(db, fx.pactId, '2030-01-08');
    const nextMon = await instanceId(db, fx.pactId, '2030-01-14');
    await freeze(a, sun, GEN_NOW);
    await freeze(a, mon, GEN_NOW); // Sunday belongs to the previous ISO week
    expect((await expectError(freeze(a, tue, GEN_NOW))).code).toBe('23514');
    expect((await expectError(freeze(a, mon, GEN_NOW))).code).toBe('23514');
    await freeze(a, nextMon, GEN_NOW);
    await freeze(b, tue, GEN_NOW);
    expect(await scalar(db, `select count(*)::int from public.freezes`)).toBe(4);
  });

  it('client RPC: participants only', async () => {
    const fx = await setup(db, { members: 3, participants: 2 });
    const inst = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at)
       values ($1, '2099-01-01', now() + interval '1 day', now() + interval '1 day 1 hour') returning id`,
      [fx.pactId],
    );
    expect(await asUser(db, fx.participantIds[0], (d) => scalar(d, `select public.declare_freeze($1)`, [inst]))).toBeTruthy();
    expect((await asUser(db, fx.userIds[2], (d) => expectError(d.query(`select public.declare_freeze($1)`, [inst])))).code).toBe('42501');
    await asAnon(db, (d) => expectError(d.query(`select public.declare_freeze($1)`, [inst]), /permission denied/));
  });
});

// ---------------------------------------------------------------------------------------------
describe('purge_old_locations', () => {
  it('nulls coordinates older than 30 days and keeps distance and verdict', async () => {
    const fx = await setup(db);
    await gen(db);
    await tick(db, MON_OPEN);
    const mon = await instanceId(db, fx.pactId, MON);
    const [a, b] = fx.participantIds;
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 1));
    await checkInAt(db, b, mon, outFence(1), at(MON_OPEN, 50));
    const purge = (now: string) => asService(db, (d) => scalar<number>(d, `select public.purge_old_locations($1::timestamptz)`, [now]));
    expect(await purge(at(MON_OPEN, 30 * 24 * 60))).toBe(0);
    expect(await purge(at(MON_OPEN, 30 * 24 * 60 + 2))).toBe(1);
    const r = await rows<any>(db, `select user_id, lat, lng, distance_m, verdict::text from public.checkins order by server_received_at`);
    expect(r[0]).toMatchObject({ user_id: a, lat: null, lng: null, verdict: 'in_fence' });
    expect(r[0].distance_m).not.toBeNull();
    expect(r[1].lat).not.toBeNull();
    expect(await purge(at(MON_OPEN, 30 * 24 * 60 + 2))).toBe(0);
    expect(await purge(at(MON_OPEN, 40 * 24 * 60))).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('security', () => {
  it('jobs and internals are not executable by clients; client RPCs are executable by authenticated only', async () => {
    const fns = await rows<{ proname: string; sig: string; anon: boolean; auth: boolean; svc: boolean; definer: boolean; cfg: string[] | null }>(
      db,
      `select p.proname, p.oid::regprocedure::text sig, p.prosecdef definer, p.proconfig cfg,
              has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') auth,
              has_function_privilege('service_role', p.oid, 'execute') svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in
          ('generate_instances','tick_instances','purge_old_locations','default_open_reviews',
           'check_in','declare_freeze','open_review','cast_vote',
           'check_in_at','declare_freeze_at','open_review_at','cast_vote_at')`,
    );
    const by = (n: string) => fns.filter((f) => f.proname === n);
    for (const n of ['check_in', 'declare_freeze', 'open_review', 'cast_vote']) {
      expect(by(n).length, n).toBe(1);
      expect(by(n)[0], n).toMatchObject({ anon: false, auth: true, definer: true });
    }
    for (const n of ['generate_instances', 'tick_instances', 'purge_old_locations', 'default_open_reviews']) {
      expect(by(n)[0], n).toMatchObject({ anon: false, auth: false, svc: true, definer: true });
    }
    for (const n of ['check_in_at', 'declare_freeze_at', 'open_review_at', 'cast_vote_at']) {
      expect(by(n)[0], n).toMatchObject({ anon: false, auth: false });
    }
    for (const f of fns) expect(f.cfg ?? [], f.sig).toContain('search_path=pg_catalog, public, pg_temp');
    await asUser(db, (await setup(db)).ownerId, (d) => expectError(d.query(`select public.tick_instances()`), /permission denied/));
  });

  it('RLS: a non-member sees no instances, check-ins, freezes or results; members do', async () => {
    const fx = await setup(db);
    const [a, b] = fx.participantIds;
    await gen(db);
    const mon = await instanceId(db, fx.pactId, MON);
    await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [b, mon, GEN_NOW]);
    await tick(db, MON_OPEN);
    await checkInAt(db, a, mon, inFence(0), at(MON_OPEN, 1));
    await tick(db, MON_DEADLINE);
    const outsider = await createUser(db);
    const count = (u: string, t: string) => asUser(db, u, (d) => scalar<number>(d, `select count(*)::int from public.${t}`));
    for (const t of ['pact_instances', 'checkins', 'freezes', 'results']) {
      expect(await count(outsider, t), t).toBe(0);
      expect(await count(fx.userIds[2], t), t).toBeGreaterThan(0);
    }
    await asUser(db, a, (d) => expectError(d.query(`update public.results set status = 'success'`), /permission denied/));
    await asUser(db, a, (d) => expectError(d.query(`update public.pact_instances set status = 'open'`), /permission denied/));
  });
});

// ---------------------------------------------------------------------------------------------
// pgTAP mirror: run pgtap/instances_test.sql against the same minimal shim as pgtap-dryrun.test.ts.
const SHIM = `
create schema extensions;
grant usage on schema extensions to public;
create table extensions.tap_log (n serial, ok boolean, descr text);
grant all on extensions.tap_log to public;
grant all on sequence extensions.tap_log_n_seq to public;
create function extensions.plan(int) returns text language sql as $$ select 'plan ' || $1 $$;
create function extensions._r(ok boolean, d text) returns text language plpgsql as $$
begin insert into extensions.tap_log (ok, descr) values (ok, d); return d; end $$;
create function extensions.is(anyelement, anyelement, text) returns text language sql as
  $$ select extensions._r($1 is not distinct from $2, $3 || ' [got ' || coalesce($1::text, 'null') || ']') $$;
create function extensions.isnt(anyelement, anyelement, text) returns text language sql as
  $$ select extensions._r($1 is distinct from $2, $3) $$;
create function extensions.throws_ok(text, text, text, text) returns text language plpgsql as $$
begin execute $1; return extensions._r(false, $4 || ' [no error]');
exception when others then return extensions._r(sqlstate = $2, $4 || ' [' || sqlstate || ' ' || sqlerrm || ']'); end $$;
create function extensions.lives_ok(text, text) returns text language plpgsql as $$
begin execute $1; return extensions._r(true, $2);
exception when others then return extensions._r(false, $2 || ' [' || sqlerrm || ']'); end $$;
create function extensions.finish() returns setof text language sql as $$ select 'done' $$;
`;

it('pgtap/instances_test.sql passes against a pgTAP shim', async () => {
  await db.exec(SHIM);
  const src = readFileSync(new URL('./pgtap/instances_test.sql', import.meta.url), 'utf8');
  const planned = Number(/select plan\((\d+)\)/.exec(src)?.[1]);
  const body = src.replace(/create extension if not exists pgtap[^;]*;/, '').replace(/^rollback;\s*$/m, '');
  await db.exec(body);
  const log = (await db.query<{ ok: boolean; descr: string }>(`select ok, descr from extensions.tap_log order by n`)).rows;
  await db.exec('rollback');
  expect(log.filter((l) => !l.ok).map((l) => l.descr)).toEqual([]);
  expect(log.length).toBe(planned);
});
