import { beforeEach, describe, expect, it } from 'vitest';
import { asAnon, asUser, createDb, createGroupFixture, createUser, rows, scalar, type DB, type GroupFixture } from './helpers/db';

// 20261108000800_instance_nets.sql: `instance_member_nets`, the posted ledger effect of one instance per
// member, straight from ledger_lines (no client arithmetic). The check-in screen shows it at gate close.
//
// Fixture pact: Mon-Fri 08:00-09:00 America/Los_Angeles, 500 cents. January 2030 is PST (UTC-8), so a
// local date D has window D 16:00Z and deadline D 17:00Z.
const GEN_NOW = '2030-01-06T12:00:00Z'; // Sunday: generates Mon 7 .. Fri 11
const openOf = (d: string) => `${d}T16:00:00.000Z`;
const deadlineOf = (d: string) => `${d}T17:00:00.000Z`;
const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();

type Outcome = 'success' | 'failed' | 'unverified';
type Fx = GroupFixture & { pactId: string };

interface NetRow {
  instance_id: string;
  group_id: string;
  user_id: string;
  net_cents: number;
  pot_cents: number;
}

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

const tick = (now: string) => db.query(`select public.tick_instances($1::timestamptz)`, [now]);
const gen = (now: string) => db.query(`select public.generate_instances(7, $1::timestamptz)`, [now]);
const instanceOf = (pactId: string, date: string) =>
  scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);
const placeOf = (i: number) => ({ lat: 47.6553 + i * 0.01, lng: -122.3035 });

async function setup(members = 3): Promise<Fx> {
  const fx = (await createGroupFixture(db, { members })) as Fx;
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  await gen(GEN_NOW);
  return fx;
}

function checkInAt(user: string, inst: string, fix: { lat: number; lng: number; acc: number }, now: string, captured = now) {
  return db.query(
    `select public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, false, null, $7::timestamptz)`,
    [user, inst, fix.lat, fix.lng, fix.acc, captured, now],
  );
}

/** Opens and closes the pact's instance for `date` with the given outcome per participant (in fixture order). */
async function closeDay(fx: Fx, date: string, outcomes: Outcome[]): Promise<string> {
  const inst = await instanceOf(fx.pactId, date);
  await tick(openOf(date));
  for (const [i, o] of outcomes.entries()) {
    if (o === 'failed') continue;
    await checkInAt(fx.participantIds[i]!, inst, { ...placeOf(i), acc: o === 'success' ? 10 : 250 }, at(openOf(date), 10 + i));
  }
  await tick(deadlineOf(date));
  expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('closed');
  return inst;
}

const netsAs = (user: string, inst: string) =>
  asUser(db, user, (d) =>
    rows<NetRow>(
      d,
      `select instance_id, group_id, user_id, net_cents::int as net_cents, pot_cents::int as pot_cents
         from public.instance_member_nets where instance_id = $1 order by user_id`,
      [inst],
    ),
  );

/** Lines of this instance's entries on the pact's carry account (what left or entered the carry). */
const carryDelta = (inst: string) =>
  scalar<number>(
    db,
    `select coalesce(sum(l.amount_cents), 0)::int
       from public.ledger_lines l
       join public.ledger_entries e on e.id = l.entry_id
       join public.ledger_accounts a on a.id = l.account_id
      where e.instance_id = $1 and a.kind = 'carry'`,
    [inst],
  );

describe('instance_member_nets', () => {
  it('one row per member who moved money, net and pot straight from the ledger, zero-sum with the carry', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds as [string, string, string];
    const inst = await closeDay(fx, '2030-01-07', ['success', 'failed', 'failed']);

    const nets = await netsAs(a, inst);
    expect(nets).toHaveLength(3);
    const byUser = new Map(nets.map((n) => [n.user_id, n]));
    expect(byUser.get(a)!.net_cents).toBe(1000);
    expect(byUser.get(b)!.net_cents).toBe(-500);
    expect(byUser.get(c)!.net_cents).toBe(-500);
    for (const n of nets) {
      expect(n.pot_cents).toBe(1000);
      expect(n.group_id).toBe(fx.groupId);
      expect(n.instance_id).toBe(inst);
    }
    expect(nets.reduce((s, n) => s + n.net_cents, 0) + (await carryDelta(inst))).toBe(0);
  });

  it('all-fail: everyone pays, the pot rolls into the carry; the next winning day pays it out and the pot includes it', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds as [string, string, string];
    const d1 = await closeDay(fx, '2030-01-07', ['failed', 'failed', 'failed']);
    const n1 = await netsAs(a, d1);
    expect(n1.map((n) => n.net_cents)).toEqual([-500, -500, -500]);
    expect(n1.every((n) => n.pot_cents === 1500)).toBe(true);
    expect(n1.reduce((s, n) => s + n.net_cents, 0) + (await carryDelta(d1))).toBe(0);

    const d2 = await closeDay(fx, '2030-01-08', ['success', 'failed', 'success']);
    expect(await scalar<number>(db, `select carry_in_cents::int from public.pact_instances where id = $1`, [d2])).toBe(1500);
    const n2 = await netsAs(b, d2);
    const byUser = new Map(n2.map((n) => [n.user_id, n]));
    // pot = 500 (b) + 1500 carried = 2000, split two ways
    expect(byUser.get(a)!.net_cents).toBe(1000);
    expect(byUser.get(c)!.net_cents).toBe(1000);
    expect(byUser.get(b)!.net_cents).toBe(-500);
    expect(n2.every((n) => n.pot_cents === 2000)).toBe(true);
    expect(n2.reduce((s, n) => s + n.net_cents, 0) + (await carryDelta(d2))).toBe(0);
  });

  it('a day that moved no money has no rows (nobody missed; unverified never costs anyone)', async () => {
    const fx = await setup(3);
    const inst = await closeDay(fx, '2030-01-07', ['success', 'success', 'unverified']);
    expect(await scalar<number>(db, `select count(*)::int from public.results where instance_id = $1`, [inst])).toBe(3);
    expect(await netsAs(fx.participantIds[0]!, inst)).toEqual([]);
    expect(await netsAs(fx.participantIds[2]!, inst)).toEqual([]);
  });

  it('members only: someone outside the group sees nothing, anon cannot read it', async () => {
    const fx = await setup(3);
    const inst = await closeDay(fx, '2030-01-07', ['success', 'failed', 'failed']);
    const outsider = await createUser(db);
    expect(await netsAs(outsider, inst)).toEqual([]);
    // a member who is not on the pact still sees the group's day (same rule as the ledger tables)
    const other = await createGroupFixture(db, { members: 1, pact: false });
    expect(await netsAs(other.ownerId, inst)).toEqual([]);
    await expect(asAnon(db, (d) => rows(d, `select * from public.instance_member_nets`))).rejects.toThrow(/permission denied/);
  });

  it('is read-only for clients', async () => {
    const fx = await setup(3);
    await expect(
      asUser(db, fx.participantIds[0]!, (d) =>
        d.query(`insert into public.instance_member_nets (instance_id, group_id, user_id, net_cents, pot_cents) values (gen_random_uuid(), $1, $2, 1, 1)`, [
          fx.groupId,
          fx.participantIds[0],
        ]),
      ),
    ).rejects.toThrow(/permission denied|cannot insert/);
  });
});
