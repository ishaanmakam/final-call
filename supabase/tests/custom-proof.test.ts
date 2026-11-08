// Custom-kind proof (20261109000300_custom_proof.sql): a custom pact may require a photo with every
// mark. The wizard's "Needs a photo" switch (CB-9) had nowhere to go; this adds `pacts.proof_required`,
// a 15th `create_pact` argument and the refusal in `mark_done`. Written before the migration; every
// test here failed against the migrations up to 20261109000200.
import { beforeEach, describe, expect, it } from 'vitest';
import { asAnon, asUser, createDb, createGroupFixture, createUser, expectError, rows, scalar, type DB, type GroupFixture } from './helpers/db';

const TZ = 'America/Los_Angeles';
// Monday 2030-01-07, 08:00-09:00 local is PST (UTC-8)
const GEN_NOW = '2030-01-06T12:00:00Z';
const D1_OPEN = '2030-01-07T16:00:00Z';
const D1_DEADLINE = '2030-01-07T17:00:00Z';
const code = async (p: Promise<unknown>) => (await expectError(p)).code;

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

type Custom = { proof?: boolean | null; kind?: string; period?: string; goal?: number | null; unit?: string | null; types?: string[] | null; days?: number[] | null };

/** The 15-argument create_pact; defaults make a daily custom pact Mon-Fri 08:00-09:00. */
function createCustom(fx: GroupFixture, o: Custom = {}, creator = fx.ownerId): Promise<string> {
  return asUser(db, creator, (d) =>
    scalar<string>(
      d,
      `select public.create_pact($1, 'Read 20 pages', $2::smallint[], '08:00', '09:00', 500, $3, $4::public.pact_kind, $5::public.pact_period,
                                 $6::numeric, $7, $8::text[], null, null, $9)`,
      [fx.groupId, o.days === undefined ? [1, 2, 3, 4, 5] : o.days, TZ, o.kind ?? 'custom', o.period ?? 'daily', o.goal ?? null, o.unit ?? null, o.types ?? null, o.proof === undefined ? true : o.proof],
    ),
  );
}

/** Everyone joins and is backdated onto every 2030 roster; the Monday instance is generated and opened. */
async function openDay(fx: GroupFixture, pactId: string): Promise<string> {
  for (const u of fx.userIds) await asUser(db, u, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [pactId]));
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pactId]);
  await db.query(`select public.generate_instances(7, $1::timestamptz)`, [GEN_NOW]);
  const inst = await scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = '2030-01-07'`, [pactId]);
  await db.query(`select public.tick_instances($1::timestamptz)`, [D1_OPEN]);
  expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('open');
  return inst;
}

const markAt = (user: string, inst: string, photo: string | null, now: string) =>
  db.query(`select public.mark_done_at($1, $2, $3, $4::timestamptz)`, [user, inst, photo, now]);
const completions = (inst: string) =>
  rows<{ user_id: string; photo_path: string | null }>(db, `select user_id, photo_path from public.custom_completions where instance_id = $1 order by user_id`, [inst]);
const proofOf = (pactId: string) => scalar<boolean>(db, `select proof_required from public.pacts where id = $1`, [pactId]);

describe('pacts.proof_required and create_pact', () => {
  it('the column exists, boolean not null default false; the 7- and 14-argument calls still work and store false', async () => {
    const col = await rows<{ data_type: string; is_nullable: string; column_default: string }>(
      db,
      `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'pacts' and column_name = 'proof_required'`,
    );
    expect(col).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    const seven = await asUser(db, fx.ownerId, (d) => scalar<string>(d, `select public.create_pact($1, 'class', '{1,2}', '08:00', '09:00', 500, $2)`, [fx.groupId, TZ]));
    expect(await proofOf(seven)).toBe(false);
    const fourteen = await asUser(db, fx.ownerId, (d) =>
      scalar<string>(d, `select public.create_pact($1, 'pages', '{1,2}', '08:00', '09:00', 500, $2, 'custom', 'daily', null, null, null, null, null)`, [fx.groupId, TZ]),
    );
    expect(await proofOf(fourteen)).toBe(false);
    expect(await rows(db, `select kind::text k, period::text p from public.pacts where id = $1`, [fourteen])).toEqual([{ k: 'custom', p: 'daily' }]);
  });

  it('p_proof_required true is stored for a custom pact (daily or weekly); null reads as false', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    expect(await proofOf(await createCustom(fx, { proof: true }))).toBe(true);
    expect(await proofOf(await createCustom(fx, { proof: true, period: 'weekly', days: null }))).toBe(true);
    expect(await proofOf(await createCustom(fx, { proof: false }))).toBe(false);
    expect(await proofOf(await createCustom(fx, { proof: null }))).toBe(false);
  });

  it('p_proof_required true on any other kind is refused (22023); false is fine', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    expect(await code(createCustom(fx, { proof: true, kind: 'show_up' }))).toBe('22023');
    expect(await code(createCustom(fx, { proof: true, kind: 'distance', period: 'weekly', days: null, goal: 24140, unit: 'm', types: ['running'] }))).toBe('22023');
    expect(await code(createCustom(fx, { proof: true, kind: 'steps', goal: 10000, unit: 'steps' }))).toBe('22023');
    expect(await proofOf(await createCustom(fx, { proof: false, kind: 'show_up' }))).toBe(false);
  });

  it('the other create_pact rules still apply through the new signature (membership, title, custom has no goal)', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    const outsider = await createUser(db);
    expect(await code(createCustom(fx, {}, outsider))).toBe('42501');
    expect(await code(createCustom(fx, { goal: 3, unit: 'count' }))).toBe('22023');
    expect(await code(createCustom(fx, { period: 'once' }))).toBe('22023');
  });

  it('proof_required is locked once a window has opened, like the kind and goal (23514)', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    const pact = await createCustom(fx, { proof: false });
    await db.query(`update public.pacts set proof_required = true where id = $1`, [pact]);
    expect(await proofOf(pact)).toBe(true);
    await openDay(fx, pact);
    expect(await code(db.query(`update public.pacts set proof_required = false where id = $1`, [pact]))).toBe('23514');
    // title and stake can still change
    await db.query(`update public.pacts set title = 'Read 30 pages', stake_cents = 700 where id = $1`, [pact]);
    expect(await proofOf(pact)).toBe(true);
  });
});

describe('mark_done with proof_required', () => {
  it('refuses a mark without a photo (23514 "This challenge needs a photo") and accepts one with it', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ, members: 3 });
    const pact = await createCustom(fx, { proof: true });
    const inst = await openDay(fx, pact);
    const [a, b] = fx.userIds;
    const err = await expectError(markAt(a!, inst, null, '2030-01-07T16:30:00Z'));
    expect(err.code).toBe('23514');
    expect(err.message).toMatch(/This challenge needs a photo/);
    const blank = await expectError(markAt(a!, inst, '   ', '2030-01-07T16:30:00Z'));
    expect(blank.code).toBe('23514');
    expect(await completions(inst)).toEqual([]);

    await markAt(a!, inst, `${fx.groupId}/${a}/proof.jpg`, '2030-01-07T16:31:00Z');
    expect(await completions(inst)).toEqual([{ user_id: a, photo_path: `${fx.groupId}/${a}/proof.jpg` }]);

    // the client RPC carries the same rule (it runs on the real clock, so only the refusal is checked here;
    // the photo check comes before the window checks, which is why a 2030 instance still answers it)
    const viaRpc = await expectError(asUser(db, b!, (d) => d.query(`select public.mark_done($1)`, [inst])));
    expect(viaRpc.code).toBe('23514');
    expect(viaRpc.message).toMatch(/This challenge needs a photo/);
    await markAt(b!, inst, `${fx.groupId}/${b}/proof.jpg`, '2030-01-07T16:32:00Z');
    expect((await completions(inst)).map((c) => c.user_id)).toEqual([a, b].sort());
  });

  it('a repeat mark without a photo keeps the first mark and its photo', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    const pact = await createCustom(fx, { proof: true });
    const inst = await openDay(fx, pact);
    const a = fx.userIds[0]!;
    await markAt(a, inst, 'g/u/one.jpg', '2030-01-07T16:10:00Z');
    await markAt(a, inst, null, '2030-01-07T16:20:00Z');
    expect(await rows(db, `select to_char(marked_at at time zone 'UTC', 'HH24:MI') m, photo_path from public.custom_completions where instance_id = $1`, [inst])).toEqual([
      { m: '16:10', photo_path: 'g/u/one.jpg' },
    ]);
  });

  it('a custom pact without the requirement still accepts a bare mark, and the day scores success at close', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ, members: 2 });
    const pact = await createCustom(fx, { proof: false });
    const inst = await openDay(fx, pact);
    const [a, b] = fx.userIds;
    await markAt(a!, inst, null, '2030-01-07T16:30:00Z');
    expect(await completions(inst)).toEqual([{ user_id: a, photo_path: null }]);
    await db.query(`select public.tick_instances($1::timestamptz)`, [new Date(Date.parse(D1_DEADLINE) + 60_000).toISOString()]);
    expect(await rows(db, `select user_id, status::text from public.results where instance_id = $1 order by user_id`, [inst])).toEqual(
      [
        { user_id: a, status: 'success' },
        { user_id: b, status: 'failed' },
      ].sort((x, y) => (x.user_id! < y.user_id! ? -1 : 1)),
    );
  });

  it('a proof pact where nobody attached a photo scores everyone failed: no mark, no success', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ, members: 2 });
    const pact = await createCustom(fx, { proof: true });
    const inst = await openDay(fx, pact);
    for (const u of fx.userIds) expect(await code(markAt(u, inst, null, '2030-01-07T16:30:00Z'))).toBe('23514');
    await db.query(`select public.tick_instances($1::timestamptz)`, [new Date(Date.parse(D1_DEADLINE) + 60_000).toISOString()]);
    expect(await rows(db, `select distinct status::text from public.results where instance_id = $1`, [inst])).toEqual([{ status: 'failed' }]);
  });
});

describe('privileges', () => {
  it('create_pact (15 args) is the one client-callable create_pact; its renamed predecessor is not', async () => {
    const fns = await rows<{ name: string; nargs: number; auth: boolean; anon: boolean; secdef: boolean; sp: boolean }>(
      db,
      `select p.proname name, p.pronargs nargs,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon,
              p.prosecdef secdef,
              coalesce(p.proconfig, '{}') @> array['search_path=pg_catalog, public, pg_temp'] sp
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('create_pact', '_create_pact_v2') order by p.proname`,
    );
    expect(fns).toEqual([
      { name: '_create_pact_v2', nargs: 14, auth: false, anon: false, secdef: true, sp: true },
      { name: 'create_pact', nargs: 15, auth: true, anon: false, secdef: true, sp: true },
    ]);
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    await asAnon(db, (d) => expectError(d.query(`select public.create_pact($1, 'x', '{1}', '08:00', '09:00', 500, 'UTC')`, [fx.groupId])));
    await asUser(db, fx.ownerId, (d) =>
      expectError(d.query(`select public._create_pact_v2($1, 'x', '{1}', '08:00', '09:00', 500, 'UTC', 'show_up', 'daily', null, null, null, null, null)`, [fx.groupId]), /permission denied/i),
    );
  });
});
