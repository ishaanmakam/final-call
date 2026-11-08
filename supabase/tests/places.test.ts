// Place accountability (20261108000100_place_accountability.sql): every member can see every
// participant's current and pending place (and how far apart they are); a changed place counts
// only once another member confirms it (never sooner than 12 h after the change) or after 24 h
// without an objection; an objection blocks it; a participant with no place in force when a
// window opens is not on that instance's roster (no money moves for them).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  createDb,
  createGroupFixture,
  createUser,
  expectError,
  rows,
  scalar,
  type DB,
  type GroupFixture,
} from './helpers/db';

type Fx = GroupFixture & { pactId: string };

let db: DB;
let dayN = 0;

beforeEach(async () => {
  db = await createDb();
});

const LNG = -122.3035;
const latOf = (i: number) => 47.6553 + i * 0.01;
const HOME = { lat: 47.7, lng: -122.4 }; // ~6 km from every fixture place
const DORM = { lat: 47.6612, lng: -122.3144 }; // ~1 km from place 0
const NIL_UUID = '00000000-0000-4000-8000-000000000000';
const code = async (p: Promise<unknown>) => (await expectError(p)).code;

/**
 * Fixture joins happen at wall-clock now(): backdate the joins and the first places so they are
 * in force for every window below (created_at stays now, so the first places remain objectable).
 */
async function fixture(members = 3, participants?: number): Promise<Fx> {
  const fx = (await createGroupFixture(db, { members, participants })) as Fx;
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  await db.query(`update public.pact_participant_places set effective_from = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  return fx;
}

/** Instance with a window relative to real now() (minutes). */
async function mkInstance(pactId: string, openMin: number, deadlineMin: number, status = 'scheduled') {
  const ld = new Date(Date.UTC(2041, 0, 1 + dayN++)).toISOString().slice(0, 10);
  return scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
     values ($1, $2::date, now() + $3::float8 * interval '1 minute', now() + $4::float8 * interval '1 minute', $5::instance_status)
     returning id`,
    [pactId, ld, openMin, deadlineMin, status],
  );
}

const joinPact = (u: string, pact: string, lat: number, lng: number, r = 100, label = 'x') =>
  asUser(db, u, (d) => d.query(`select public.join_pact($1, $2, $3, $4, $5)`, [pact, lat, lng, r, label]));
const ack = (u: string, place: string) => asUser(db, u, (d) => d.query(`select public.acknowledge_place($1)`, [place]));
const object = (u: string, place: string, reason: string | null = 'That is a dorm, not a lecture hall') =>
  asUser(db, u, (d) => d.query(`select public.object_place($1, $2)`, [place, reason]));
const leave = (u: string, g: string) => asUser(db, u, (d) => d.query(`select public.leave_group($1)`, [g]));

interface PlaceRow {
  id: string;
  lat: number;
  label: string | null;
  requires_ack: boolean;
  effective_from: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  objected_at: string | null;
  objected_by: string | null;
  objection_reason: string | null;
  delay_s: number;
}
const places = (fx: Fx, u: string) =>
  rows<PlaceRow>(
    db,
    `select id, lat, label, requires_ack, effective_from, created_at, acknowledged_at, acknowledged_by, objected_at, objected_by,
            objection_reason, extract(epoch from effective_from - created_at)::int delay_s
       from public.pact_participant_places where pact_id = $1 and user_id = $2 order by created_at, effective_from`,
    [fx.pactId, u],
  );
const latest = async (fx: Fx, u: string) => (await places(fx, u)).at(-1)!;
const placeById = async (id: string) => (await rows<PlaceRow>(db, `select *, 0 as delay_s from public.pact_participant_places where id = $1`, [id]))[0]!;

/** The place a window opening at `at` (an instance id) is judged against, via the server's _place_at. */
const placeAt = (fx: Fx, u: string, inst: string) =>
  scalar<number | null>(
    db,
    `select (public._place_at($1, $2, i.window_open_at)).lat from public.pact_instances i where i.id = $3`,
    [fx.pactId, u, inst],
  );
const roster = (inst: string) =>
  rows<{ u: string }>(db, `select u::text from public._instance_participants($1) u`, [inst]).then((r) => r.map((x) => x.u).sort());

/** check_in_at with server time = window_open_at + 5 minutes */
const verdictAtOpen = (u: string, inst: string, lat: number, lng: number) =>
  scalar<string>(
    db,
    `select (public.check_in_at($1, $2, $3, $4, 10, x.t, false, null, x.t)).verdict::text
       from (select window_open_at + interval '5 minutes' t from public.pact_instances where id = $2) x`,
    [u, inst, lat, lng],
  );

interface EventRow {
  kind: string;
  user_id: string;
  actor_id: string;
  place_id: string | null;
  label: string | null;
  prev_label: string | null;
  distance_from_prev_m: number | null;
  reason: string | null;
}
const events = (fx: Fx) =>
  rows<EventRow>(
    db,
    `select kind, user_id, actor_id, place_id, label, prev_label, distance_from_prev_m, reason
       from public.place_events where pact_id = $1 order by id`,
    [fx.pactId],
  );
const outbox = () =>
  rows<{ user_id: string; kind: string; payload: any }>(
    db,
    `select user_id, kind, payload from public.notification_outbox where kind = 'place_changed' order by id`,
  );

/** Pretend the row was created `hours` ago (the fixture cannot wait). */
const age = (placeId: string, hours: number) =>
  db.query(
    `update public.pact_participant_places
        set created_at = created_at - $2 * interval '1 hour', effective_from = effective_from - $2 * interval '1 hour'
      where id = $1`,
    [placeId, hours],
  );

// =============================================================================================
describe('visibility', () => {
  it("every member sees every participant's current and pending place, with who set it and its state", async () => {
    const fx = await fixture(4, 3);
    const [a, b] = fx.participantIds;
    const watcher = fx.userIds[3]; // in the group, not in the pact
    const visible = (u: string) =>
      asUser(db, u, (d) =>
        rows<any>(
          d,
          `select user_id, user_name, label, radius_m, state, is_current, requires_ack, acknowledgeable, objectable
             from public.pact_places_visible where pact_id = $1 order by user_id, created_at`,
          [fx.pactId],
        ),
      );
    const before = await visible(watcher);
    expect(before).toHaveLength(3);
    for (const r of before) {
      expect(r).toMatchObject({ state: 'effective', is_current: true, requires_ack: false, acknowledgeable: false, objectable: true });
    }
    expect(before.find((r) => r.user_id === a)).toMatchObject({ user_name: 'Member 1', label: 'place 0', radius_m: 100 });

    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'new gym');
    const after = await visible(b);
    expect(after.filter((r) => r.user_id === a).map((r) => [r.label, r.state, r.is_current, r.acknowledgeable, r.objectable])).toEqual([
      ['place 0', 'effective', true, false, true],
      ['new gym', 'pending', false, true, true],
    ]);

    // outsiders and anon see nothing
    const outsider = await createUser(db);
    expect((await visible(outsider)).length).toBe(0);
    await asAnon(db, (d) => expectError(d.query(`select 1 from public.pact_places_visible`), /permission denied/));
  });

  it("pact_place_distances: pairwise metres between each place and the others' current places", async () => {
    const fx = await fixture(3);
    const [a, b, c] = fx.participantIds;
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'far away');
    const dist = await asUser(db, b, (d) =>
      rows<{ user_id: string; other_user_id: string; label: string; distance_m: number }>(
        d,
        `select user_id, other_user_id, label, distance_m from public.pact_place_distances($1) order by user_id, label, other_user_id`,
        [fx.pactId],
      ),
    );
    // not for outsiders
    const outsider = await createUser(db);
    expect(await code(asUser(db, outsider, (d) => d.query(`select * from public.pact_place_distances($1)`, [fx.pactId])))).toBe('42501');
    // a's current place to b and c, a's pending place to b and c, b's to a and c, c's to a and b
    expect(dist).toHaveLength(8);
    const ab = dist.find((r) => r.user_id === a && r.other_user_id === b && r.label === 'place 0')!;
    expect(ab.distance_m).toBeGreaterThan(1100);
    expect(ab.distance_m).toBeLessThan(1125); // 0.01 deg of latitude
    const farB = dist.find((r) => r.user_id === a && r.other_user_id === b && r.label === 'far away')!;
    expect(farB.distance_m).toBeGreaterThan(5000);
    expect(dist.filter((r) => r.user_id === b).map((r) => r.other_user_id).sort()).toEqual([a, c].sort());
    // the other side is always the place in force, never a pending one
    expect(dist.filter((r) => r.user_id === b && r.other_user_id === a).map((r) => Math.round(r.distance_m))).toEqual([Math.round(ab.distance_m)]);
  });

  it('clients cannot write places or events directly', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    const placeId = (await latest(fx, a)).id;
    await asUser(db, a, async (d) => {
      await expectError(d.query(`update public.pact_participant_places set acknowledged_at = now() where id = $1`, [placeId]), /permission denied/);
      await expectError(
        d.query(`insert into public.place_events (group_id, pact_id, user_id, actor_id, kind) values ($1, $2, $3, $3, 'acknowledged')`, [
          fx.groupId,
          fx.pactId,
          a,
        ]),
        /permission denied/,
      );
      await expectError(d.query(`delete from public.place_events`), /permission denied/);
    });
  });
});

// =============================================================================================
describe('acknowledgement gate', () => {
  it('a first place counts at once; a change counts after 24 h unless confirmed, and never before 12 h', async () => {
    const fx = await fixture();
    const [a, b] = fx.participantIds;
    expect(await latest(fx, a)).toMatchObject({ requires_ack: false });
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'new gym');
    const pending = await latest(fx, a);
    expect(pending).toMatchObject({ requires_ack: true, delay_s: 24 * 3600, acknowledged_at: null, objected_at: null });

    await ack(b, pending.id);
    const acked = await latest(fx, a);
    expect(acked.acknowledged_by).toBe(b);
    expect(acked.delay_s).toBe(12 * 3600); // confirmed at once: still waits for the 12 h minimum

    // confirmed after 13 hours: counts from the confirmation
    await joinPact(a, fx.pactId, DORM.lat, DORM.lng, 100, 'later');
    const second = await latest(fx, a);
    await age(second.id, 13);
    await ack(b, second.id);
    const eff = await scalar<number>(db, `select extract(epoch from effective_from - now()) from public.pact_participant_places where id = $1`, [second.id]);
    expect(Math.abs(eff)).toBeLessThan(5);
  });

  it('attack: moving your fence to the dorm the night before does not count without a confirmation', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    const tomorrow = await mkInstance(fx.pactId, 13 * 60, 14 * 60); // 13 h out, past the old 12 h rule
    await joinPact(a, fx.pactId, DORM.lat, DORM.lng, 100, 'dorm');
    expect(await placeAt(fx, a, tomorrow)).toBe(latOf(0)); // judged against the old place
    expect(await roster(tomorrow)).toEqual([...fx.participantIds].sort()); // still in (previous place applies)
    expect(await verdictAtOpen(a, tomorrow, DORM.lat, DORM.lng)).toBe('out_of_fence');
    expect(await verdictAtOpen(a, tomorrow, latOf(0), LNG)).toBe('in_fence');
  });

  it('a confirmed change applies to windows opening 12+ hours after it', async () => {
    const fx = await fixture();
    const [a, b] = fx.participantIds;
    const soon = await mkInstance(fx.pactId, 60, 120);
    const later = await mkInstance(fx.pactId, 13 * 60, 14 * 60);
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'new gym');
    await ack(b, (await latest(fx, a)).id);
    expect(await placeAt(fx, a, soon)).toBe(latOf(0));
    expect(await placeAt(fx, a, later)).toBe(HOME.lat);
    expect(await verdictAtOpen(a, later, HOME.lat, HOME.lng)).toBe('in_fence');
  });

  it('self-acknowledgement, outsiders and former members are rejected; no double confirmation; nothing to confirm once it counts', async () => {
    const fx = await fixture(4);
    const [a, b, c, d] = fx.participantIds;
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'new gym');
    const p = (await latest(fx, a)).id;
    expect(await code(ack(a, p))).toBe('42501');
    const outsider = await createUser(db);
    expect(await code(ack(outsider, p))).toBe('42501');
    await asAnon(db, (dd) => expectError(dd.query(`select public.acknowledge_place($1)`, [p]), /permission denied/));
    await leave(d, fx.groupId);
    expect(await code(ack(d, p))).toBe('42501');
    expect(await code(ack(b, NIL_UUID))).toBe('P0002');
    await ack(b, p);
    expect(await code(ack(c, p))).toBe('23514'); // already confirmed
    // a timed-out place already counts: nothing to confirm
    await joinPact(a, fx.pactId, DORM.lat, DORM.lng, 100, 'dorm');
    const q = (await latest(fx, a)).id;
    await age(q, 25);
    expect(await code(ack(b, q))).toBe('23514');
    expect(await placeById(q)).toMatchObject({ requires_ack: true, acknowledged_at: null });
  });

  it('nobody else in the group: the first place counts at once, a change waits the 12 hours and needs no confirmation', async () => {
    const fx = (await createGroupFixture(db, { members: 1 })) as Fx;
    const [a] = fx.participantIds;
    expect((await places(fx, a))[0]).toMatchObject({ requires_ack: false, delay_s: 0 });
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'new gym');
    expect(await latest(fx, a)).toMatchObject({ requires_ack: false, delay_s: 12 * 3600 });
  });

  it('a new request replaces a pending one; switching back to the place in force cancels it; label edits change nothing', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'gym');
    await joinPact(a, fx.pactId, DORM.lat, DORM.lng, 100, 'dorm');
    expect((await places(fx, a)).map((p) => p.label)).toEqual(['place 0', 'dorm']);
    await joinPact(a, fx.pactId, latOf(0), LNG, 100, 'place 0 renamed');
    expect((await places(fx, a)).map((p) => p.label)).toEqual(['place 0']);
    expect(await scalar(db, `select place_label from public.pact_participants where pact_id = $1 and user_id = $2`, [fx.pactId, a])).toBe('place 0 renamed');
    // the cancelled requests leave their feed rows (snapshot), unlinked
    expect((await events(fx)).filter((e) => e.user_id === a && e.kind === 'created').map((e) => [e.label, e.place_id === null])).toEqual([
      ['place 0', false],
      ['gym', true],
      ['dorm', true],
    ]);
  });

  it('the existing refusals stay: no change once a window has opened; no join after a window opened', async () => {
    const fx = await fixture(4, 3);
    const [a] = fx.participantIds;
    await mkInstance(fx.pactId, -1, 59);
    expect(await code(joinPact(a, fx.pactId, HOME.lat, HOME.lng))).toBe('23514');
    expect(await code(joinPact(fx.userIds[3], fx.pactId, HOME.lat, HOME.lng))).toBe('23514');
  });
});

// =============================================================================================
describe('objections', () => {
  it('an objection blocks a pending place; the setter must set a new one', async () => {
    const fx = await fixture();
    const [a, b, c] = fx.participantIds;
    const dayAfter = await mkInstance(fx.pactId, 25 * 60, 26 * 60);
    await joinPact(a, fx.pactId, DORM.lat, DORM.lng, 100, 'dorm');
    const p = (await latest(fx, a)).id;
    expect(await code(object(b, p, '  '))).toBe('22023'); // a reason is required
    expect(await code(object(a, p))).toBe('42501'); // not your own
    await object(b, p);
    expect(await latest(fx, a)).toMatchObject({ objected_by: b, objection_reason: 'That is a dorm, not a lecture hall' });
    expect(await code(ack(c, p))).toBe('23514'); // blocked: cannot be confirmed any more
    expect(await code(object(c, p))).toBe('23514'); // already objected
    await age(p, 25); // even after the 24 h it never counts
    expect(await placeAt(fx, a, dayAfter)).toBe(latOf(0));
    expect(await scalar(db, `select state from public.pact_places_visible where place_id = $1`, [p])).toBe('objected');
    // a new place starts the gate again; the objected row stays in the history
    await joinPact(a, fx.pactId, latOf(0) + 0.001, LNG, 100, 'lecture hall');
    const hall = (await latest(fx, a)).id;
    expect(
      (await places(fx, a)).map((x) => [x.label, x.objected_at !== null, x.requires_ack]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual([
      ['dorm', true, true],
      ['lecture hall', false, true],
      ['place 0', false, false],
    ]);
    await ack(c, hall);
    await age(hall, 13);
    expect(await placeAt(fx, a, dayAfter)).toBe(latOf(0) + 0.001);
  });

  it('a confirmed place or one older than 24 h cannot be objected to', async () => {
    const fx = await fixture();
    const [a, b, c] = fx.participantIds;
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'gym');
    const p = (await latest(fx, a)).id;
    await ack(b, p);
    expect(await code(object(c, p))).toBe('23514');
    const first = (await places(fx, b))[0]!.id;
    await age(first, 25);
    expect(await code(object(a, first))).toBe('23514');
  });

  it('objecting to a first place within 24 h takes that person off later rosters until a new place is confirmed; no money moves for them', async () => {
    const fx = await fixture(3);
    const [a, b, c] = fx.participantIds;
    const open = await mkInstance(fx.pactId, -10, 50, 'open');
    const next = await mkInstance(fx.pactId, 10, 70);
    const first = (await places(fx, a))[0]!.id;
    await object(c, first, 'That is his bedroom');
    expect(await roster(open)).toEqual([a, b, c].sort()); // the window opened before the objection
    expect(await roster(next)).toEqual([b, c].sort()); // no place in force when this one opens
    expect(await placeAt(fx, a, next)).toBeNull();
    // time passes (p_now): `next` opens and closes; b shows up, c misses; a gets no result and no ledger line
    await db.query(
      `select public.check_in_at($1, $2, $3, $4, 10, now() + interval '30 minutes', false, null, now() + interval '30 minutes')`,
      [b, next, latOf(1), LNG],
    );
    expect(
      await code(
        db.query(`select public.check_in_at($1, $2, $3, $4, 10, now() + interval '20 minutes', false, null, now() + interval '20 minutes')`, [a, next, latOf(0), LNG]),
      ),
    ).toBe('42501'); // a is not on the roster
    await db.query(`select public.tick_instances(now() + interval '71 minutes')`); // closes both
    const results = await rows<{ user_id: string; status: string }>(db, `select user_id, status::text from public.results where instance_id = $1 order by user_id`, [next]);
    expect(results.map((r) => [r.user_id, r.status]).sort()).toEqual([[b, 'success'], [c, 'failed']].sort());
    expect(await scalar<number>(db, `select count(*)::int from public.results where instance_id = $1 and user_id = $2`, [next, a])).toBe(0);
    expect(await scalar<number>(db, `select coalesce(sum(amount_cents), 0)::int from public.ledger_lines`)).toBe(0); // zero-sum
    const netOn = (inst: string, u: string) =>
      scalar<number>(
        db,
        `select coalesce(sum(l.amount_cents), 0)::int
           from public.ledger_lines l
           join public.ledger_entries e on e.id = l.entry_id
           join public.ledger_accounts acc on acc.id = l.account_id
          where e.instance_id = $1 and acc.kind = 'member' and acc.user_id = $2`,
        [inst, u],
      );
    // `open` (before the objection) closed first with everyone missing: 3 x 500 rolled into the carry,
    // which the only winner of `next` draws (F2). a is simply absent from `next`.
    expect(await scalar<number>(db, `select carry_in_cents::int from public.pact_instances where id = $1`, [next])).toBe(1500);
    expect(await netOn(next, a)).toBe(0);
    expect(await netOn(next, b)).toBe(500 + 1500);
    expect(await netOn(next, c)).toBe(-500);
    // the window that opened before the objection scored a as usual
    expect(await scalar<number>(db, `select count(*)::int from public.results where instance_id = $1 and user_id = $2`, [open, a])).toBe(1);
  });

  it('a two-person pact whose other place is objected to voids the day: nobody pays', async () => {
    const fx = await fixture(2);
    const [a, b] = fx.participantIds;
    const next = await mkInstance(fx.pactId, 10, 70);
    await object(b, (await places(fx, a))[0]!.id, 'nope');
    await db.query(`select public.tick_instances(now() + interval '71 minutes')`);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [next])).toBe('voided');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(0);
  });
});

// =============================================================================================
describe('feed events and notifications', () => {
  it('created / acknowledged / objected rows with the previous place and its distance; members are notified', async () => {
    const fx = await fixture();
    const [a, b, c] = fx.participantIds;
    await db.query(`delete from public.notification_outbox`);
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'new gym');
    const p = (await latest(fx, a)).id;
    let ev = await events(fx);
    expect(ev.filter((e) => e.kind === 'created')).toHaveLength(4); // 3 first places + the change
    const created = ev.at(-1)!;
    expect(created).toMatchObject({ kind: 'created', user_id: a, actor_id: a, place_id: p, label: 'new gym', prev_label: 'place 0' });
    expect(created.distance_from_prev_m).toBeGreaterThan(5000);
    let ob = await outbox();
    expect(ob.map((o) => o.user_id).sort()).toEqual([b, c].sort());
    expect(ob[0]!.payload).toMatchObject({
      event: 'created',
      place_id: p,
      pact_id: fx.pactId,
      group_id: fx.groupId,
      user_id: a,
      user_name: 'Member 1',
      label: 'new gym',
      prev_label: 'place 0',
      requires_ack: true,
    });

    await db.query(`delete from public.notification_outbox`);
    await ack(b, p);
    ev = await events(fx);
    expect(ev.at(-1)).toMatchObject({ kind: 'acknowledged', user_id: a, actor_id: b, place_id: p });
    ob = await outbox();
    expect(ob.map((o) => [o.user_id, o.payload.event, o.payload.actor_name])).toEqual([[a, 'acknowledged', 'Member 2']]);

    await joinPact(a, fx.pactId, DORM.lat, DORM.lng, 100, 'dorm');
    const q = (await latest(fx, a)).id;
    await db.query(`delete from public.notification_outbox`);
    await object(c, q, 'Not a classroom');
    expect((await events(fx)).at(-1)).toMatchObject({ kind: 'objected', user_id: a, actor_id: c, place_id: q, reason: 'Not a classroom' });
    expect((await outbox()).map((o) => [o.user_id, o.payload.event, o.payload.reason])).toEqual([[a, 'objected', 'Not a classroom']]);
  });

  it('24 h without an objection makes the place count; the tick posts the event once', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    const later = await mkInstance(fx.pactId, 60, 120);
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng, 150, 'new gym');
    const p = (await latest(fx, a)).id;
    await db.query(`delete from public.notification_outbox`);
    await db.query(`select public.tick_instances(now())`);
    expect((await events(fx)).filter((e) => e.kind === 'effective')).toHaveLength(0);
    await age(p, 25);
    expect(await placeAt(fx, a, later)).toBe(HOME.lat);
    await db.query(`select public.tick_instances(now())`);
    await db.query(`select public.tick_instances(now())`);
    const eff = (await events(fx)).filter((e) => e.kind === 'effective');
    expect(eff).toHaveLength(1);
    expect(eff[0]).toMatchObject({ user_id: a, actor_id: a, place_id: p, label: 'new gym' });
    expect((await outbox()).map((o) => [o.user_id, o.payload.event])).toEqual([[a, 'effective']]);
    expect(await scalar(db, `select state from public.pact_places_visible where place_id = $1`, [p])).toBe('effective');
    // first places and confirmed places never get a timeout event
    expect(await scalar<number>(db, `select count(*)::int from public.place_events where kind = 'effective'`)).toBe(1);
  });

  it('feed rows are readable by current members only', async () => {
    const fx = await fixture();
    const [, b] = fx.participantIds;
    expect(await asUser(db, b, (d) => scalar<number>(d, `select count(*)::int from public.place_events where pact_id = $1`, [fx.pactId]))).toBe(3);
    const outsider = await createUser(db);
    expect(await asUser(db, outsider, (d) => scalar<number>(d, `select count(*)::int from public.place_events`))).toBe(0);
    await asAnon(db, (d) => expectError(d.query(`select 1 from public.place_events`), /permission denied/));
    await leave(b, fx.groupId);
    expect(await asUser(db, b, (d) => scalar<number>(d, `select count(*)::int from public.place_events`))).toBe(0);
  });
});
