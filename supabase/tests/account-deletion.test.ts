// In-app account deletion (App Store 5.1.1(v)): `delete_my_account()` leaves every group through the
// existing leave rules, anonymizes the profile, drops the device-level data (push tokens, pending
// places, votes on open reviews, raw coordinates) and erases the auth identity, while every
// append-only money record (results, ledger, obligations, reviews) stays under "Deleted member".
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
  type GroupFixture,
} from './helpers/db';

type Status = 'success' | 'failed' | 'unverified' | 'frozen' | 'void' | 'excluded';

/** A closed instance with the given results (the settlement suite's fixture shape). */
async function closedInstance(db: DB, pactId: string, localDate: string, results: [string, Status][]): Promise<string> {
  const id = await scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status, closed_at)
     select $1, d, t - interval '1 hour', t, 'closed', t
       from (select $2::date d, ($2::date + time '09:00') at time zone p.tz t from public.pacts p where p.id = $1) x
     returning id`,
    [pactId, localDate],
  );
  for (const [uid, st] of results) {
    await db.query(`insert into public.results (instance_id, user_id, status, first_success_at) values ($1, $2, $3, $4)`, [
      id,
      uid,
      st,
      st === 'success' ? `${localDate}T15:30:00Z` : null,
    ]);
  }
  return id;
}

interface LedgerSnapshot {
  entries: number;
  lines: number;
  total: number;
  unbalanced: number;
}
async function ledger(db: DB): Promise<LedgerSnapshot> {
  const r = (
    await db.query<{ entries: number; lines: number; total: string; unbalanced: number }>(
      `select (select count(*)::int from public.ledger_entries) entries,
              (select count(*)::int from public.ledger_lines) lines,
              (select coalesce(sum(amount_cents), 0)::text from public.ledger_lines) total,
              (select count(*)::int from (select entry_id from public.ledger_lines group by entry_id having sum(amount_cents) <> 0) x) unbalanced`,
    )
  ).rows[0]!;
  return { entries: r.entries, lines: r.lines, total: Number(r.total), unbalanced: r.unbalanced };
}

const deleteAccount = (db: DB, uid: string) => asUser(db, uid, (d) => d.query('select public.delete_my_account()'));

let db: DB;
let fx: GroupFixture;
let leaver: string; // the one who deletes their account (a plain member)
let other: string; // the group owner, who stays
let third: string;

/**
 * A settled week in which `leaver` missed and `other` showed up: a payout entry, a settlement, and a
 * pending obligation leaver -> other. Plus the device-level data the deletion must remove.
 */
beforeEach(async () => {
  db = await createDb();
  fx = await createGroupFixture(db, { members: 3 });
  [other, leaver, third] = fx.userIds as [string, string, string];
  await db.query(`update public.groups set created_at = '2026-10-28T19:00:00Z' where id = $1`, [fx.groupId]);
  const inst = await closedInstance(db, fx.pactId!, '2026-10-28', [
    [other, 'success'],
    [leaver, 'failed'],
    [third, 'frozen'],
  ]);
  // a check-in with raw coordinates and a vote on an open review of somebody else's result
  await db.query(
    `insert into public.checkins (instance_id, user_id, lat, lng, accuracy_m, distance_m, verdict)
     values ($1, $2, 47.6553, -122.3035, 12, 900, 'out_of_fence')`,
    [inst, leaver],
  );
  await asService(db, (d) => d.query(`select public.settle_due_groups('2026-11-02T20:00:00Z')`));
  await asUser(db, leaver, (d) => d.query(`select public.register_push_token('ExponentPushToken[leaver]', 'ios')`));
  await asUser(db, other, (d) => d.query(`select public.register_push_token('ExponentPushToken[other]', 'ios')`));
  await asUser(db, leaver, (d) => d.query(`update public.profiles set venmo_username = 'leaver-venmo' where id = $1`, [leaver]));
});

describe('delete_my_account: what goes', () => {
  it('anonymizes the profile, drops push tokens and leaves every group', async () => {
    await deleteAccount(db, leaver);
    const p = await rows<{ display_name: string; venmo_username: string | null; deleted_at: string | null }>(
      db,
      `select display_name, venmo_username, deleted_at from public.profiles where id = $1`,
      [leaver],
    );
    expect(p).toHaveLength(1); // the row stays: results / ledger / obligations point at it
    expect(p[0]).toMatchObject({ display_name: 'Deleted member', venmo_username: null });
    expect(p[0]!.deleted_at).not.toBeNull();
    expect(await scalar<number>(db, `select count(*)::int from public.push_tokens where user_id = $1`, [leaver])).toBe(0);
    expect(
      await scalar<number>(db, `select count(*)::int from public.group_members where user_id = $1 and left_at is null`, [leaver]),
    ).toBe(0);
    expect(
      await scalar<number>(db, `select count(*)::int from public.pact_participants where user_id = $1 and left_at is null`, [leaver]),
    ).toBe(0);
    // the auth identity is gone (the PGlite stub has a real auth.users table)
    expect(await scalar<number>(db, `select count(*)::int from auth.users where id = $1`, [leaver])).toBe(0);
    // one audit row
    const audit = await rows<{ user_id: string; kind: string }>(db, `select user_id::text, kind from public.account_audit`);
    expect(audit).toEqual([{ user_id: leaver, kind: 'account_deleted' }]);
  });

  it('nulls raw check-in coordinates but keeps the verdict and distance', async () => {
    await deleteAccount(db, leaver);
    const c = await rows<{ lat: number | null; lng: number | null; distance_m: number; verdict: string }>(
      db,
      `select lat, lng, distance_m, verdict::text from public.checkins where user_id = $1`,
      [leaver],
    );
    expect(c).toEqual([{ lat: null, lng: null, distance_m: 900, verdict: 'out_of_fence' }]);
  });

  it('removes their votes on open reviews only; resolved votes and reviews they opened stay', async () => {
    // an open review about `other` with leaver's vote, and a resolved one about `third` with leaver's vote
    const inst = await scalar<string>(db, `select instance_id from public.results where user_id = $1 limit 1`, [leaver]);
    const openId = await scalar<string>(
      db,
      `insert into public.reviews (instance_id, subject_user_id, opened_by, kind, reason, status)
       values ($1, $2, $3, 'challenge', 'not there', 'open') returning id`,
      [inst, other, third],
    );
    const doneId = await scalar<string>(
      db,
      `insert into public.reviews (instance_id, subject_user_id, opened_by, kind, reason, status, resolved_at)
       values ($1, $2, $3, 'appeal', 'bus broke down', 'rejected', now()) returning id`,
      [inst, third, leaver],
    );
    await db.query(`insert into public.review_votes (review_id, voter_id, supports) values ($1, $2, true), ($3, $2, false)`, [
      openId,
      leaver,
      doneId,
    ]);
    await deleteAccount(db, leaver);
    const votes = await rows<{ review_id: string }>(db, `select review_id from public.review_votes where voter_id = $1`, [leaver]);
    expect(votes.map((v) => v.review_id)).toEqual([doneId]);
    expect(await scalar<string>(db, `select opened_by::text from public.reviews where id = $1`, [doneId])).toBe(leaver);
  });

  it('deletes a pending place change of theirs and their unsent notifications', async () => {
    // a pending (gated) place row: effective_from in the future
    await db.query(
      `insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from, requires_ack)
       values ($1, $2, 47.7, -122.3, 100, 'new place', now() + interval '20 hours', true)`,
      [fx.pactId, leaver],
    );
    await db.query(`insert into public.notification_outbox (user_id, kind, payload) values ($1, 'result', '{}')`, [leaver]);
    await deleteAccount(db, leaver);
    expect(
      await scalar<number>(
        db,
        `select count(*)::int from public.pact_participant_places where user_id = $1 and effective_from > now()`,
        [leaver],
      ),
    ).toBe(0);
    // the historical place row (what their past verdicts were judged against) stays
    expect(await scalar<number>(db, `select count(*)::int from public.pact_participant_places where user_id = $1`, [leaver])).toBe(1);
    expect(
      await scalar<number>(db, `select count(*)::int from public.notification_outbox where user_id = $1 and sent_at is null`, [leaver]),
    ).toBe(0);
  });
});

describe('delete_my_account: what stays', () => {
  it('leaves the ledger untouched and zero-sum, results and the settlement intact', async () => {
    const before = await ledger(db);
    expect(before.entries).toBeGreaterThan(0);
    const resultsBefore = await rows(db, `select instance_id, user_id, status from public.results order by user_id`);
    await deleteAccount(db, leaver);
    expect(await ledger(db)).toEqual(before);
    expect(before.total).toBe(0);
    expect(before.unbalanced).toBe(0);
    expect(await rows(db, `select instance_id, user_id, status from public.results order by user_id`)).toEqual(resultsBefore);
    expect(await scalar<number>(db, `select count(*)::int from public.settlements where group_id = $1`, [fx.groupId])).toBe(1);
    // the deleted member's balance is still derivable (views sum lines; nothing is stored)
    expect(
      Number(await scalar(db, `select balance_cents from public.member_balances where group_id = $1 and user_id = $2`, [fx.groupId, leaver])),
    ).toBe(-500);
  });

  it('the counterparty still sees the obligation, and the payer reads as "Deleted member"', async () => {
    await deleteAccount(db, leaver);
    const seen = await asUser(db, other, (d) =>
      rows<{ from_user: string; to_user: string; amount_cents: string; status: string; from_name: string }>(
        d,
        `select o.from_user::text, o.to_user::text, o.amount_cents::text, o.status::text, p.display_name from_name
           from public.obligations o join public.profiles p on p.id = o.from_user
          where o.to_user = auth.uid()`,
      ),
    );
    expect(seen).toEqual([{ from_user: leaver, to_user: other, amount_cents: '500', status: 'pending', from_name: 'Deleted member' }]);
  });

  it('other users are unaffected', async () => {
    await deleteAccount(db, leaver);
    const o = await rows<{ display_name: string; deleted_at: string | null }>(
      db,
      `select display_name, deleted_at from public.profiles where id = $1`,
      [other],
    );
    expect(o[0]!.deleted_at).toBeNull();
    expect(o[0]!.display_name).not.toBe('Deleted member');
    expect(await scalar<number>(db, `select count(*)::int from public.push_tokens where user_id = $1`, [other])).toBe(1);
    expect(
      await scalar<number>(db, `select count(*)::int from public.group_members where group_id = $1 and left_at is null`, [fx.groupId]),
    ).toBe(2);
    expect(await scalar<number>(db, `select count(*)::int from auth.users`)).toBe(2);
  });
});

describe('delete_my_account: refusals and idempotence', () => {
  it('refuses while the caller is on the roster of an open check-in window, and changes nothing', async () => {
    // on the roster = joined before the window opened (leave_group's rule)
    await db.query(`update public.pact_participants set joined_at = now() - interval '1 day' where pact_id = $1`, [fx.pactId]);
    await db.query(`update public.pact_participant_places set effective_from = now() - interval '1 day' where pact_id = $1`, [fx.pactId]);
    await db.query(
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
       values ($1, '2099-01-01', now() - interval '10 minutes', now() + interval '50 minutes', 'open')`,
      [fx.pactId],
    );
    const err = await expectError(deleteAccount(db, leaver), /open check-in window/i);
    expect(err.code).toBe('23514');
    expect(err.message).toMatch(/try again after the deadline/i);
    expect(await scalar<string>(db, `select display_name from public.profiles where id = $1`, [leaver])).not.toBe('Deleted member');
    expect(await scalar<number>(db, `select count(*)::int from public.push_tokens where user_id = $1`, [leaver])).toBe(1);
    expect(await scalar<number>(db, `select count(*)::int from public.account_audit`)).toBe(0);
  });

  it('a second call is a no-op (one audit row, no error)', async () => {
    await deleteAccount(db, leaver);
    await deleteAccount(db, leaver);
    expect(await scalar<number>(db, `select count(*)::int from public.account_audit where user_id = $1`, [leaver])).toBe(1);
  });

  it('cannot be aimed at anybody else: no argument, authenticated only, never anon', async () => {
    const fns = await rows<{ sig: string; anon: boolean; auth: boolean; secdef: boolean }>(
      db,
      `select p.oid::regprocedure::text sig, p.prosecdef secdef,
              has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'delete_my_account'`,
    );
    expect(fns).toEqual([{ sig: 'delete_my_account()', secdef: true, anon: false, auth: true }]);
    await expectError(asAnon(db, (d) => d.query('select public.delete_my_account()')));
    // user A deleting themselves never touches B
    const b = await createUser(db, 'b@x.test', 'B');
    await deleteAccount(db, b);
    expect(await scalar<string>(db, `select display_name from public.profiles where id = $1`, [leaver])).not.toBe('Deleted member');
    expect(await scalar<string>(db, `select display_name from public.profiles where id = $1`, [b])).toBe('Deleted member');
  });

  it('the anonymized profile can no longer be edited through the client grant', async () => {
    await deleteAccount(db, leaver);
    // the auth row is gone; a stale JWT with that sub must not be able to put a name back
    await asUser(db, leaver, (d) => d.query(`update public.profiles set display_name = 'Back again' where id = $1`, [leaver]));
    expect(await scalar<string>(db, `select display_name from public.profiles where id = $1`, [leaver])).toBe('Deleted member');
  });
});
