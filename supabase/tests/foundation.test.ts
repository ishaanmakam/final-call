import { beforeEach, describe, expect, it } from 'vitest';
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
} from './helpers/db';

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

// ---------- small local helpers ----------
async function memberAccount(groupId: string, userId: string) {
  return scalar<string>(db, `select public.ensure_account($1, 'member', $2, null, null)`, [groupId, userId]);
}
async function insertInstance(pactId: string, localDate = '2026-11-09') {
  return scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
     values ($1, $2::date, ($2::date + time '08:00') at time zone 'America/Los_Angeles',
                           ($2::date + time '09:00') at time zone 'America/Los_Angeles', 'open')
     returning id`,
    [pactId, localDate],
  );
}
async function postEntry(groupId: string, key: string, lines: { account_id: string; amount_cents: number }[], kind = 'stake', instance: string | null = null) {
  return scalar<string | null>(
    db,
    `select public.post_entry($1, $2::public.entry_kind, $3, $4, 'memo', $5::jsonb)`,
    [groupId, kind, key, instance, JSON.stringify(lines)],
  );
}

// =====================================================================
describe('schema hygiene', () => {
  it('RLS is enabled on every table in public', async () => {
    const off = await rows(
      db,
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity`,
    );
    expect(off).toEqual([]);
    const count = await scalar<number>(
      db,
      `select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(count).toBeGreaterThanOrEqual(18);
  });

  it('every SECURITY DEFINER function in public pins search_path', async () => {
    const bad = await rows(
      db,
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(bad).toEqual([]);
  });

  it('views are security_invoker so RLS applies through them', async () => {
    const v = await rows<{ relname: string; reloptions: string[] | null }>(
      db,
      `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v' and c.relname in ('account_balances','member_balances')`,
    );
    expect(v.length).toBe(2);
    for (const r of v) expect(r.reloptions ?? []).toContain('security_invoker=true');
  });

  it('cron migration applies as a no-op without pg_cron', async () => {
    expect(await scalar(db, `select to_regnamespace('cron') is null`)).toBe(true);
  });

  it('auth.users insert creates a profile', async () => {
    const id = await createUser(db, 'alice@example.com');
    const p = await rows(db, `select display_name from public.profiles where id = $1`, [id]);
    expect(p).toEqual([{ display_name: 'alice' }]);
  });
});

// =====================================================================
describe('ledger: ensure_account', () => {
  it('get-or-create returns the same id and enforces one account per identity', async () => {
    const f = await createGroupFixture(db, { members: 2 });
    const a1 = await memberAccount(f.groupId, f.userIds[0]);
    const a2 = await memberAccount(f.groupId, f.userIds[0]);
    expect(a1).toBe(a2);
    const carry1 = await scalar(db, `select public.ensure_account($1,'carry',null,null,$2)`, [f.groupId, f.pactId]);
    const carry2 = await scalar(db, `select public.ensure_account($1,'carry',null,null,$2)`, [f.groupId, f.pactId]);
    expect(carry1).toBe(carry2);
    const inst = await insertInstance(f.pactId!);
    const pot1 = await scalar(db, `select public.ensure_account($1,'pot',null,$2,null)`, [f.groupId, inst]);
    const pot2 = await scalar(db, `select public.ensure_account($1,'pot',null,$2,$3)`, [f.groupId, inst, f.pactId]);
    expect(pot1).toBe(pot2);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_accounts`)).toBe(3);
    await expectError(
      db.query(`insert into public.ledger_accounts (group_id, kind, user_id) values ($1,'member',$2)`, [f.groupId, f.userIds[0]]),
    );
  });

  it('rejects accounts whose pact/instance/user does not belong to the group', async () => {
    const f = await createGroupFixture(db, { members: 2 });
    const g = await createGroupFixture(db, { members: 2 });
    await expectError(db.query(`select public.ensure_account($1,'carry',null,null,$2)`, [f.groupId, g.pactId]));
    await expectError(db.query(`select public.ensure_account($1,'member',$2,null,null)`, [f.groupId, g.userIds[1]]));
    await expectError(db.query(`select public.ensure_account($1,'member',null,null,null)`, [f.groupId]));
  });
});

// =====================================================================
describe('ledger: post_entry', () => {
  let f: Awaited<ReturnType<typeof createGroupFixture>>;
  let a: string, b: string, c: string;
  beforeEach(async () => {
    f = await createGroupFixture(db, { members: 3 });
    a = await memberAccount(f.groupId, f.userIds[0]);
    b = await memberAccount(f.groupId, f.userIds[1]);
    c = await memberAccount(f.groupId, f.userIds[2]);
  });

  it('is idempotent: same key + same lines returns the existing id and inserts nothing', async () => {
    const lines = [
      { account_id: a, amount_cents: -500 },
      { account_id: b, amount_cents: 500 },
    ];
    const id1 = await postEntry(f.groupId, 'k1', lines);
    const id2 = await postEntry(f.groupId, 'k1', [...lines].reverse());
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(1);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(2);
  });

  it('raises when a key is reused with different lines', async () => {
    await postEntry(f.groupId, 'k1', [
      { account_id: a, amount_cents: -500 },
      { account_id: b, amount_cents: 500 },
    ]);
    await expectError(
      postEntry(f.groupId, 'k1', [
        { account_id: a, amount_cents: -400 },
        { account_id: b, amount_cents: 400 },
      ]),
      /idempotency/i,
    );
    await expectError(
      postEntry(f.groupId, 'k1', [
        { account_id: a, amount_cents: -500 },
        { account_id: c, amount_cents: 500 },
      ]),
      /idempotency/i,
    );
    // same lines but a different kind is also a conflict
    await expectError(
      postEntry(f.groupId, 'k1', [
        { account_id: a, amount_cents: -500 },
        { account_id: b, amount_cents: 500 },
      ], 'payout'),
      /idempotency/i,
    );
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(2);
  });

  it('merges lines per account and drops zero lines', async () => {
    const id = await postEntry(f.groupId, 'merge', [
      { account_id: a, amount_cents: -300 },
      { account_id: a, amount_cents: -200 },
      { account_id: b, amount_cents: 500 },
      { account_id: c, amount_cents: 0 },
      { account_id: c, amount_cents: 70 },
      { account_id: c, amount_cents: -70 },
    ]);
    const ls = await rows<{ account_id: string; amount_cents: string }>(
      db,
      `select account_id, amount_cents::text from public.ledger_lines where entry_id = $1 order by amount_cents`,
      [id],
    );
    expect(ls).toEqual([
      { account_id: a, amount_cents: '-500' },
      { account_id: b, amount_cents: '500' },
    ]);
    // the merged form is what idempotency compares against
    const again = await postEntry(f.groupId, 'merge', [
      { account_id: b, amount_cents: 500 },
      { account_id: a, amount_cents: -500 },
    ]);
    expect(again).toBe(id);
  });

  it('returns null and inserts nothing when lines net to zero', async () => {
    const id = await postEntry(f.groupId, 'nothing', [
      { account_id: a, amount_cents: 100 },
      { account_id: a, amount_cents: -100 },
    ]);
    expect(id).toBeNull();
    const id2 = await postEntry(f.groupId, 'nothing2', []);
    expect(id2).toBeNull();
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(0);
  });

  it('rejects unbalanced lines up front', async () => {
    await expectError(
      postEntry(f.groupId, 'bad', [
        { account_id: a, amount_cents: -500 },
        { account_id: b, amount_cents: 400 },
      ]),
      /zero/i,
    );
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(0);
  });

  it('rejects lines on accounts of another group', async () => {
    const g = await createGroupFixture(db, { members: 2 });
    const x = await memberAccount(g.groupId, g.userIds[0]);
    await expectError(
      postEntry(f.groupId, 'cross', [
        { account_id: a, amount_cents: -500 },
        { account_id: x, amount_cents: 500 },
      ]),
    );
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(0);
  });

  it('zero-sum is enforced at commit by a deferred constraint trigger', async () => {
    // balanced: individual inserts are temporarily unbalanced, commit succeeds
    await db.transaction(async (tx) => {
      const e = (await tx.query<{ id: string }>(
        `insert into public.ledger_entries (group_id, kind, idempotency_key, memo) values ($1,'stake','direct-ok','') returning id`,
        [f.groupId],
      )).rows[0].id;
      await tx.query(`insert into public.ledger_lines (entry_id, account_id, amount_cents) values ($1,$2,-10)`, [e, a]);
      await tx.query(`insert into public.ledger_lines (entry_id, account_id, amount_cents) values ($1,$2,10)`, [e, b]);
    });
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(1);

    // unbalanced: each insert succeeds, the commit fails, nothing persists
    await expectError(
      db.transaction(async (tx) => {
        const e = (await tx.query<{ id: string }>(
          `insert into public.ledger_entries (group_id, kind, idempotency_key, memo) values ($1,'stake','direct-bad','') returning id`,
          [f.groupId],
        )).rows[0].id;
        await tx.query(`insert into public.ledger_lines (entry_id, account_id, amount_cents) values ($1,$2,-10)`, [e, a]);
        await tx.query(`insert into public.ledger_lines (entry_id, account_id, amount_cents) values ($1,$2,9)`, [e, b]);
      }),
      /zero/i,
    );
    // an entry with no lines is also rejected at commit
    await expectError(
      db.query(`insert into public.ledger_entries (group_id, kind, idempotency_key, memo) values ($1,'stake','empty','')`, [f.groupId]),
      /line/i,
    );
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(1);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(2);
  });

  it('ledger rows are append-only (UPDATE/DELETE raise, even for superuser and service_role)', async () => {
    const id = await postEntry(f.groupId, 'k', [
      { account_id: a, amount_cents: -500 },
      { account_id: b, amount_cents: 500 },
    ]);
    await expectError(db.query(`update public.ledger_entries set memo = 'x' where id = $1`, [id]), /append-only/i);
    await expectError(db.query(`delete from public.ledger_entries where id = $1`, [id]), /append-only/i);
    await expectError(db.query(`update public.ledger_lines set amount_cents = 1 where entry_id = $1`, [id]), /append-only/i);
    await expectError(db.query(`delete from public.ledger_lines where entry_id = $1`, [id]), /append-only/i);
    await expectError(db.query(`truncate public.ledger_lines`), /append-only/i);
    await asService(db, async (d) => {
      await expectError(d.query(`delete from public.ledger_lines where entry_id = $1`, [id]), /append-only/i);
    });
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(2);
  });

  it('account_balances and member_balances sum the lines', async () => {
    const inst = await insertInstance(f.pactId!);
    const pot = await scalar<string>(db, `select public.ensure_account($1,'pot',null,$2,$3)`, [f.groupId, inst, f.pactId]);
    // a and b fail (stake 500 each into pot), c wins the pot of 1000
    await postEntry(f.groupId, `stake:${inst}`, [
      { account_id: a, amount_cents: -500 },
      { account_id: b, amount_cents: -500 },
      { account_id: pot, amount_cents: 1000 },
    ], 'stake', inst);
    expect(await scalar<string>(db, `select balance_cents::text from public.account_balances where account_id = $1`, [pot])).toBe('1000');
    await postEntry(f.groupId, `payout:${inst}`, [
      { account_id: pot, amount_cents: -1000 },
      { account_id: c, amount_cents: 1000 },
    ], 'payout', inst);
    // an account with no lines still shows up with 0
    const d = await createUser(db);
    await asUser(db, d, (x) => x.query(`select public.join_group($1)`, [f.inviteCode]));
    await memberAccount(f.groupId, d);

    const mb = await rows<{ user_id: string; balance_cents: string }>(
      db,
      `select user_id, balance_cents::text from public.member_balances where group_id = $1 order by balance_cents, user_id`,
      [f.groupId],
    );
    const byUser = Object.fromEntries(mb.map((r) => [r.user_id, r.balance_cents]));
    expect(byUser).toEqual({ [f.userIds[0]]: '-500', [f.userIds[1]]: '-500', [f.userIds[2]]: '1000', [d]: '0' });
    expect(await scalar<string>(db, `select balance_cents::text from public.account_balances where account_id = $1`, [pot])).toBe('0');
    expect(await scalar<string>(db, `select sum(balance_cents)::text from public.account_balances where group_id = $1`, [f.groupId])).toBe('0');
  });

  it('client roles cannot execute post_entry or ensure_account; service_role can', async () => {
    const lines = JSON.stringify([
      { account_id: a, amount_cents: -1 },
      { account_id: b, amount_cents: 1 },
    ]);
    await asUser(db, f.userIds[0], async (d) => {
      await expectError(
        d.query(`select public.post_entry($1,'stake','evil',null,'',$2::jsonb)`, [f.groupId, lines]),
        /permission denied/i,
      );
      await expectError(
        d.query(`select public.ensure_account($1,'member',$2,null,null)`, [f.groupId, f.userIds[0]]),
        /permission denied/i,
      );
    });
    await asAnon(db, async (d) => {
      await expectError(
        d.query(`select public.post_entry($1,'stake','evil',null,'',$2::jsonb)`, [f.groupId, lines]),
        /permission denied/i,
      );
    });
    const id = await asService(db, (d) =>
      scalar(d, `select public.post_entry($1,'stake','svc',null,'',$2::jsonb)`, [f.groupId, lines]),
    );
    expect(id).toBeTruthy();
  });
});

// =====================================================================
describe('groups', () => {
  it('create_group: caller becomes owner, invite code generated, tz stored', async () => {
    const u = await createUser(db);
    const gid = await asUser(db, u, (d) => scalar<string>(d, `select public.create_group('Crew', 'America/New_York')`));
    const g = await rows(db, `select name, settlement_tz, created_by, invite_code from public.groups where id = $1`, [gid]);
    expect(g[0]).toMatchObject({ name: 'Crew', settlement_tz: 'America/New_York', created_by: u });
    expect(g[0].invite_code).toMatch(/^[0-9A-Z]{10}$/);
    const m = await rows(db, `select user_id, role, left_at from public.group_members where group_id = $1`, [gid]);
    expect(m).toEqual([{ user_id: u, role: 'owner', left_at: null }]);
  });

  it('invalid time zones are rejected (RPC and direct insert)', async () => {
    const u = await createUser(db);
    for (const tz of ['Mars/Olympus_Mons', 'PST', '+05', '', 'foo+5']) {
      await asUser(db, u, (d) => expectError(d.query(`select public.create_group('x', $1)`, [tz]), /time zone/i));
    }
    await expectError(
      db.query(`insert into public.groups (name, invite_code, settlement_tz, created_by) values ('x','ABC','Nowhere/Land',$1)`, [u]),
      /time zone/i,
    );
    expect(await scalar<number>(db, `select count(*)::int from public.groups`)).toBe(0);
  });

  it('create_group requires authentication', async () => {
    await asAnon(db, (d) => expectError(d.query(`select public.create_group('x','UTC')`)));
    // authenticated role but no sub claim
    await db.exec(`set role authenticated`);
    try {
      await expectError(db.query(`select public.create_group('x','UTC')`), /authenticated/i);
    } finally {
      await db.exec(`reset role`);
    }
  });

  it('join_group by code (case-insensitive), idempotent', async () => {
    const f = await createGroupFixture(db, { members: 1, pact: false });
    const u = await createUser(db);
    const gid = await asUser(db, u, (d) => scalar(d, `select public.join_group($1)`, [` ${f.inviteCode.toLowerCase()} `]));
    expect(gid).toBe(f.groupId);
    const again = await asUser(db, u, (d) => scalar(d, `select public.join_group($1)`, [f.inviteCode]));
    expect(again).toBe(f.groupId);
    const m = await rows(db, `select role from public.group_members where group_id = $1 and user_id = $2`, [f.groupId, u]);
    expect(m).toEqual([{ role: 'member' }]);
  });

  it('join_group with a bad code fails', async () => {
    const u = await createUser(db);
    await asUser(db, u, (d) => expectError(d.query(`select public.join_group('NOPE000000')`), /invite/i));
  });

  it('caps a group at 8 current members (RPC and direct insert)', async () => {
    const f = await createGroupFixture(db, { members: 8, pact: false });
    const ninth = await createUser(db);
    await asUser(db, ninth, (d) => expectError(d.query(`select public.join_group($1)`, [f.inviteCode]), /8/));
    await expectError(
      db.query(`insert into public.group_members (group_id, user_id, role) values ($1,$2,'member')`, [f.groupId, ninth]),
      /8/,
    );
    expect(await scalar<number>(db, `select count(*)::int from public.group_members where group_id = $1`, [f.groupId])).toBe(8);

    // a leaver frees a slot; their rejoin is then blocked while full
    const leaver = f.userIds[7];
    await asUser(db, leaver, (d) => d.query(`select public.leave_group($1)`, [f.groupId]));
    await asUser(db, ninth, (d) => d.query(`select public.join_group($1)`, [f.inviteCode]));
    await asUser(db, leaver, (d) => expectError(d.query(`select public.join_group($1)`, [f.inviteCode]), /8/));
    // reactivating via direct update is capped too
    await expectError(
      db.query(`update public.group_members set left_at = null where group_id = $1 and user_id = $2`, [f.groupId, leaver]),
      /8/,
    );
  });

  it('leave_group then join_group clears left_at; leaving also leaves the group pacts', async () => {
    const f = await createGroupFixture(db, { members: 3 });
    const u = f.userIds[2];
    await asUser(db, u, (d) => d.query(`select public.leave_group($1)`, [f.groupId]));
    expect(await scalar(db, `select left_at is not null from public.group_members where group_id=$1 and user_id=$2`, [f.groupId, u])).toBe(true);
    expect(await scalar(db, `select left_at is not null from public.pact_participants where pact_id=$1 and user_id=$2`, [f.pactId, u])).toBe(true);
    // a former member loses read access
    expect(await asUser(db, u, (d) => rows(d, `select id from public.pacts`))).toEqual([]);
    await asUser(db, u, (d) => d.query(`select public.join_group($1)`, [f.inviteCode]));
    const m = await rows(db, `select role, left_at from public.group_members where group_id=$1 and user_id=$2`, [f.groupId, u]);
    expect(m).toEqual([{ role: 'member', left_at: null }]);
  });

  it('leave_group: non-member rejected; owner leaving hands ownership to the longest-standing member', async () => {
    const f = await createGroupFixture(db, { members: 3, pact: false });
    const stranger = await createUser(db);
    await asUser(db, stranger, (d) => expectError(d.query(`select public.leave_group($1)`, [f.groupId]), /member/i));
    await asUser(db, f.ownerId, (d) => d.query(`select public.leave_group($1)`, [f.groupId]));
    const owners = await rows(db, `select user_id from public.group_members where group_id=$1 and role='owner' and left_at is null`, [f.groupId]);
    expect(owners).toEqual([{ user_id: f.userIds[1] }]);
  });
});

// =====================================================================
describe('pacts', () => {
  it('create_pact happy path; days normalized; stake/tz stored', async () => {
    const f = await createGroupFixture(db, { members: 2, pact: false });
    const pid = await asUser(db, f.userIds[1], (d) =>
      scalar<string>(d, `select public.create_pact($1,'Gym',$2::smallint[],'06:00','07:30',250,'Europe/Berlin')`, [f.groupId, [5, 1, 3, 1]]),
    );
    const p = await rows(db, `select title, days_of_week, window_open_local, deadline_local, stake_cents, tz, paused, created_by, group_id from public.pacts where id=$1`, [pid]);
    expect(p[0]).toMatchObject({
      title: 'Gym',
      days_of_week: [1, 3, 5],
      window_open_local: '06:00:00',
      deadline_local: '07:30:00',
      stake_cents: 250,
      tz: 'Europe/Berlin',
      paused: false,
      created_by: f.userIds[1],
      group_id: f.groupId,
    });
  });

  it('create_pact defaults: window = deadline - 60 min, stake 500, tz = group settlement tz', async () => {
    const f = await createGroupFixture(db, { members: 2, pact: false, tz: 'America/Chicago' });
    const pid = await asUser(db, f.ownerId, (d) =>
      scalar<string>(d, `select public.create_pact($1,'Class','{1,2}'::smallint[],null,'09:00',null,null)`, [f.groupId]),
    );
    const p = await rows(db, `select window_open_local, stake_cents, tz from public.pacts where id=$1`, [pid]);
    expect(p[0]).toEqual({ window_open_local: '08:00:00', stake_cents: 500, tz: 'America/Chicago' });
  });

  it('create_pact validates fields', async () => {
    const f = await createGroupFixture(db, { members: 2, pact: false });
    const call = (title: string, days: string, open: string | null, dl: string, stake: number, tz: string) =>
      asUser(db, f.ownerId, (d) =>
        d.query(`select public.create_pact($1,$2,$3::smallint[],$4::time,$5::time,$6,$7)`, [f.groupId, title, days, open, dl, stake, tz]),
      );
    await expectError(call('x', '{1}', '09:00', '09:00', 500, 'UTC'), /window/i);
    await expectError(call('x', '{1}', '10:00', '09:00', 500, 'UTC'), /window/i);
    await expectError(call('x', '{1}', '08:00', '09:00', 0, 'UTC'), /stake/i);
    await expectError(call('x', '{1}', '08:00', '09:00', 10001, 'UTC'), /stake/i);
    await expectError(call('x', '{}', '08:00', '09:00', 500, 'UTC'), /day/i);
    await expectError(call('x', '{0,1}', '08:00', '09:00', 500, 'UTC'), /day/i);
    await expectError(call('x', '{8}', '08:00', '09:00', 500, 'UTC'), /day/i);
    await expectError(call('x', '{1}', '08:00', '09:00', 500, 'Moon/Base'), /time zone/i);
    await expectError(call('  ', '{1}', '08:00', '09:00', 500, 'UTC'), /title/i);
    // boundaries are fine
    await call('x', '{1,2,3,4,5,6,7}', '08:59', '09:00', 1, 'UTC');
    await call('y', '{7}', '00:00', '23:59', 10000, 'UTC');
    // table-level checks hold even without the RPC
    await expectError(
      db.query(
        `insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by)
         values ($1,'t','{1}','09:00','08:00','UTC',$2)`,
        [f.groupId, f.ownerId],
      ),
    );
    await expectError(
      db.query(
        `insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by)
         values ($1,'t','{1,1}','08:00','09:00','UTC',$2)`,
        [f.groupId, f.ownerId],
      ),
    );
    await expectError(
      db.query(
        `insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by)
         values ($1,'t','{1}','08:00','09:00','Bad/Zone',$2)`,
        [f.groupId, f.ownerId],
      ),
      /time zone/i,
    );
  });

  it('create_pact requires current group membership', async () => {
    const f = await createGroupFixture(db, { members: 2, pact: false });
    const stranger = await createUser(db);
    await asUser(db, stranger, (d) =>
      expectError(d.query(`select public.create_pact($1,'x','{1}','08:00','09:00',500,'UTC')`, [f.groupId]), /member/i),
    );
    await asUser(db, f.userIds[1], (d) => d.query(`select public.leave_group($1)`, [f.groupId]));
    await asUser(db, f.userIds[1], (d) =>
      expectError(d.query(`select public.create_pact($1,'x','{1}','08:00','09:00',500,'UTC')`, [f.groupId]), /member/i),
    );
  });

  it('join_pact: members join with a place; upsert updates it; non-members rejected; radius validated', async () => {
    const f = await createGroupFixture(db, { members: 3, participants: 1 });
    const u = f.userIds[1];
    await asUser(db, u, (d) => d.query(`select public.join_pact($1, 47.6, -122.3, 150, 'Gym')`, [f.pactId]));
    await asUser(db, u, (d) => d.query(`select public.join_pact($1, 47.7, -122.4, 200, 'Other gym')`, [f.pactId]));
    const p = await rows(db, `select place_lat, place_lng, place_radius_m, place_label, left_at from public.pact_participants where pact_id=$1 and user_id=$2`, [f.pactId, u]);
    expect(p).toEqual([{ place_lat: 47.7, place_lng: -122.4, place_radius_m: 200, place_label: 'Other gym', left_at: null }]);

    const stranger = await createUser(db);
    await asUser(db, stranger, (d) => expectError(d.query(`select public.join_pact($1, 47.6, -122.3, 100, 'x')`, [f.pactId]), /member/i));
    await asUser(db, u, (d) => expectError(d.query(`select public.join_pact($1, 47.6, -122.3, 24, 'x')`, [f.pactId]), /radius/i));
    await asUser(db, u, (d) => expectError(d.query(`select public.join_pact($1, 47.6, -122.3, 501, 'x')`, [f.pactId]), /radius/i));
    await asUser(db, u, (d) => expectError(d.query(`select public.join_pact($1, 91, -122.3, 100, 'x')`, [f.pactId]), /lat/i));
    await asUser(db, u, (d) => expectError(d.query(`select public.join_pact($1, 47, 181, 100, 'x')`, [f.pactId]), /l(at|ng)/i));
    await asUser(db, u, (d) => expectError(d.query(`select public.join_pact(gen_random_uuid(), 47, 1, 100, 'x')`), /pact/i));
  });

  it('join_pact refuses to move an existing place while a window is open', async () => {
    const f = await createGroupFixture(db, { members: 2 });
    await insertInstance(f.pactId!); // status 'open'
    const u = f.userIds[1];
    await asUser(db, u, (d) => expectError(d.query(`select public.join_pact($1, 10, 10, 100, 'here')`, [f.pactId]), /open/i));
    // re-sending the identical place is harmless
    const cur = (await rows(db, `select place_lat, place_lng, place_radius_m, place_label from public.pact_participants where pact_id=$1 and user_id=$2`, [f.pactId, u]))[0];
    await asUser(db, u, (d) => d.query(`select public.join_pact($1,$2,$3,$4,$5)`, [f.pactId, cur.place_lat, cur.place_lng, cur.place_radius_m, cur.place_label]));
  });

  it('set_pact_paused: owner or pact creator only', async () => {
    const f = await createGroupFixture(db, { members: 3, pact: false });
    const creator = f.userIds[1];
    const pid = await asUser(db, creator, (d) =>
      scalar<string>(d, `select public.create_pact($1,'x','{1}','08:00','09:00',500,'UTC')`, [f.groupId]),
    );
    await asUser(db, creator, (d) => d.query(`select public.set_pact_paused($1, true)`, [pid]));
    expect(await scalar(db, `select paused from public.pacts where id=$1`, [pid])).toBe(true);
    await asUser(db, f.ownerId, (d) => d.query(`select public.set_pact_paused($1, false)`, [pid]));
    expect(await scalar(db, `select paused from public.pacts where id=$1`, [pid])).toBe(false);
    await asUser(db, f.userIds[2], (d) => expectError(d.query(`select public.set_pact_paused($1, true)`, [pid]), /owner|creator/i));
    const stranger = await createUser(db);
    await asUser(db, stranger, (d) => expectError(d.query(`select public.set_pact_paused($1, true)`, [pid])));
    expect(await scalar(db, `select paused from public.pacts where id=$1`, [pid])).toBe(false);
  });
});

// =====================================================================
describe('RLS and grants', () => {
  it('non-members see nothing of another group; members see their own', async () => {
    const f = await createGroupFixture(db, { members: 2 });
    const g = await createGroupFixture(db, { members: 2 });
    const inst = await insertInstance(f.pactId!);
    await db.query(`insert into public.results (instance_id, user_id, status) values ($1,$2,'success')`, [inst, f.userIds[0]]);
    await db.query(
      `insert into public.checkins (instance_id, user_id, client_captured_at, lat, lng, accuracy_m, distance_m, verdict)
       values ($1,$2,now(),47.6,-122.3,10,5,'in_fence')`,
      [inst, f.userIds[0]],
    );
    const a = await memberAccount(f.groupId, f.userIds[0]);
    const b = await memberAccount(f.groupId, f.userIds[1]);
    await postEntry(f.groupId, 'k', [
      { account_id: a, amount_cents: -500 },
      { account_id: b, amount_cents: 500 },
    ]);
    // predicate selecting group f's rows in each table (evaluated as the caller, so only visible rows count)
    const ofF: Record<string, string> = {
      groups: `id = p.g`,
      group_members: `group_id = p.g`,
      pacts: `group_id = p.g`,
      pact_participants: `pact_id = p.pa`,
      pact_instances: `pact_id = p.pa`,
      checkins: `instance_id = p.i`,
      results: `instance_id = p.i`,
      ledger_accounts: `group_id = p.g`,
      ledger_entries: `group_id = p.g`,
      ledger_lines: `account_id in (select id from public.ledger_accounts where group_id = p.g)`,
      account_balances: `group_id = p.g`,
      member_balances: `group_id = p.g`,
    };
    const count = (t: string) =>
      `with p as (select $1::uuid g, $2::uuid pa, $3::uuid i) select count(*)::int from public.${t} x, p where ${ofF[t]}`;
    const tables = Object.keys(ofF);
    const params = [f.groupId, f.pactId, inst];
    const truth: Record<string, number> = {};
    for (const t of tables) truth[t] = await scalar<number>(db, count(t), params);
    const outsider = g.userIds[0];
    for (const t of tables) {
      expect(truth[t], `fixture has rows in ${t}`).toBeGreaterThan(0);
      const n = await asUser(db, outsider, (d) => scalar<number>(d, count(t), params));
      expect(n, `outsider sees ${t}`).toBe(0);
      const own = await asUser(db, f.userIds[1], (d) => scalar<number>(d, count(t), params));
      expect(own, `member sees ${t}`).toBe(truth[t]);
    }
    // the outsider still sees their own group
    expect(await asUser(db, outsider, (d) => scalar<number>(d, `select count(*)::int from public.pacts`))).toBe(1);
    // anon sees nothing at all
    await asAnon(db, async (d) => {
      for (const t of tables) await expectError(d.query(`select count(*) from public.${t}`), /permission denied/i);
    });
  });

  it('members cannot write foundation tables directly', async () => {
    const f = await createGroupFixture(db, { members: 2 });
    const inst = await insertInstance(f.pactId!);
    const a = await memberAccount(f.groupId, f.userIds[0]);
    const entry = await postEntry(f.groupId, 'k', [
      { account_id: a, amount_cents: -1 },
      { account_id: await memberAccount(f.groupId, f.userIds[1]), amount_cents: 1 },
    ]);
    const u = f.userIds[0];
    const attempts: [string, any[]][] = [
      [`insert into public.ledger_lines (entry_id, account_id, amount_cents) values ($1,$2,5)`, [entry, a]],
      [`insert into public.ledger_entries (group_id, kind, idempotency_key) values ($1,'stake','x')`, [f.groupId]],
      [`insert into public.ledger_accounts (group_id, kind, user_id) values ($1,'member',$2)`, [f.groupId, u]],
      [`insert into public.results (instance_id, user_id, status) values ($1,$2,'success')`, [inst, u]],
      [`insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at) values ($1,'2026-12-01',now(),now()+interval '1h')`, [f.pactId]],
      [`insert into public.checkins (instance_id, user_id, verdict) values ($1,$2,'in_fence')`, [inst, u]],
      [`insert into public.group_members (group_id, user_id, role) values ($1, gen_random_uuid(), 'member')`, [f.groupId]],
      [`insert into public.groups (name, invite_code, settlement_tz, created_by) values ('x','y','UTC',$1)`, [u]],
      [`insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by) values ($1,'t','{1}','08:00','09:00','UTC',$2)`, [f.groupId, u]],
      [`insert into public.notification_outbox (user_id, kind, payload) values ($1,'x','{}')`, [u]],
      [`insert into public.push_tokens (user_id, token, platform) values ($1,'t','ios')`, [u]],
      [`insert into public.settlements (group_id, week_start) values ($1,'2026-11-02')`, [f.groupId]],
      [`update public.pacts set stake_cents = 1 where id = $1`, [f.pactId]],
      [`update public.group_members set role = 'owner' where user_id = $1`, [u]],
      [`update public.pact_instances set status = 'voided' where id = $1`, [inst]],
      [`update public.pact_participants set place_radius_m = 500 where user_id = $1`, [u]],
      [`delete from public.pacts where id = $1`, [f.pactId]],
      [`delete from public.group_members where user_id = $1`, [u]],
      [`update public.profiles set id = gen_random_uuid() where id = $1`, [u]],
      [`delete from public.profiles where id = $1`, [u]],
    ];
    for (const [sql, params] of attempts) {
      await asUser(db, u, (d) => expectError(d.query(sql, params), /permission denied|row-level security/i));
    }
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(2);
    expect(await scalar(db, `select stake_cents from public.pacts where id=$1`, [f.pactId])).toBe(500);
  });

  it('profiles: visible to co-members only; users can update only their own display_name', async () => {
    const f = await createGroupFixture(db, { members: 2, pact: false });
    const stranger = await createUser(db, undefined, 'Stranger');
    const seen = await asUser(db, f.userIds[0], (d) => rows<{ id: string }>(d, `select id from public.profiles order by id`));
    expect(seen.map((r) => r.id).sort()).toEqual([...f.userIds].sort());
    const strangerSees = await asUser(db, stranger, (d) => rows<{ id: string }>(d, `select id from public.profiles`));
    expect(strangerSees).toEqual([{ id: stranger }]);

    await asUser(db, f.userIds[0], (d) => d.query(`update public.profiles set display_name = 'Ishaan' where id = $1`, [f.userIds[0]]));
    expect(await scalar(db, `select display_name from public.profiles where id=$1`, [f.userIds[0]])).toBe('Ishaan');
    const res = await asUser(db, f.userIds[0], (d) => d.query(`update public.profiles set display_name = 'pwned' where id = $1`, [f.userIds[1]]));
    expect(res.affectedRows ?? 0).toBe(0);
    expect(await scalar(db, `select display_name from public.profiles where id=$1`, [f.userIds[1]])).toBe('Member 2');
    await asUser(db, f.userIds[0], (d) => expectError(d.query(`update public.profiles set display_name = '' where id = $1`, [f.userIds[0]])));
  });

  it('push tokens and outbox: own rows only; register_push_token upserts and moves a token between accounts', async () => {
    const u = await createUser(db);
    const v = await createUser(db);
    await asUser(db, u, (d) => d.query(`select public.register_push_token('ExponentPushToken[abc]', 'ios')`));
    await asUser(db, u, (d) => d.query(`select public.register_push_token('ExponentPushToken[abc]', 'ios')`));
    expect(await asUser(db, u, (d) => rows(d, `select token from public.push_tokens`))).toEqual([{ token: 'ExponentPushToken[abc]' }]);
    expect(await asUser(db, v, (d) => rows(d, `select token from public.push_tokens`))).toEqual([]);
    // the device signs into another account: token must stop going to u
    await asUser(db, v, (d) => d.query(`select public.register_push_token('ExponentPushToken[abc]', 'ios')`));
    expect(await rows(db, `select user_id from public.push_tokens`)).toEqual([{ user_id: v }]);
    await asUser(db, v, (d) => expectError(d.query(`select public.register_push_token('', 'ios')`)));

    await db.query(`insert into public.notification_outbox (user_id, kind, payload) values ($1,'result','{}'),($2,'result','{}')`, [u, v]);
    expect(await asUser(db, u, (d) => scalar<number>(d, `select count(*)::int from public.notification_outbox`))).toBe(1);
    await asUser(db, u, (d) => expectError(d.query(`update public.notification_outbox set sent_at = now()`), /permission denied/i));
  });

  it('client RPCs are executable by authenticated only, not anon', async () => {
    const fns = await rows<{ sig: string; anon: boolean; auth: boolean }>(
      db,
      `select p.oid::regprocedure::text sig,
              has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') auth
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in
         ('create_group','join_group','leave_group','create_pact','join_pact','set_pact_paused','register_push_token')`,
    );
    expect(fns.length).toBe(7);
    for (const f of fns) expect(f, f.sig).toMatchObject({ anon: false, auth: true });
    const internal = await rows<{ sig: string; anon: boolean; auth: boolean }>(
      db,
      `select p.oid::regprocedure::text sig,
              has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') auth
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('post_entry','ensure_account','handle_new_user')`,
    );
    expect(internal.length).toBe(3);
    for (const f of internal) expect(f, f.sig).toMatchObject({ anon: false, auth: false });
  });

  // Guard over ALL migrations (later agents included): Postgres grants EXECUTE to PUBLIC
  // by default, so a forgotten REVOKE on a SECURITY DEFINER function exposes it to clients.
  it('guard: no SECURITY DEFINER function is callable by anon; authenticated only gets contract RPCs + RLS helpers', async () => {
    const allowed = new Set([
      // CONTRACT.md client RPCs
      'create_group', 'join_group', 'leave_group', 'create_pact', 'join_pact', 'set_pact_paused',
      'check_in', 'declare_freeze', 'open_review', 'cast_vote', 'mark_obligation_paid', 'confirm_obligation', 'dispute_obligation',
      'register_push_token',
      // RLS helpers (must be executable by the querying role)
      'is_group_member', 'is_pact_participant', 'is_pact_group_member', 'is_instance_group_member', 'shares_group_with',
    ]);
    const exposed = await rows<{ proname: string; sig: string; anon: boolean; auth: boolean }>(
      db,
      `select p.proname, p.oid::regprocedure::text sig,
              has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') auth
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef`,
    );
    expect(exposed.filter((f) => f.anon).map((f) => f.sig), 'SECURITY DEFINER executable by anon').toEqual([]);
    expect(
      exposed.filter((f) => f.auth && !allowed.has(f.proname)).map((f) => f.sig),
      'SECURITY DEFINER executable by authenticated but not a contract RPC',
    ).toEqual([]);
  });
});
