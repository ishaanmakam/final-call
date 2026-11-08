// Adversarial suite: a malicious authenticated user (and anon) tries to break authorization and
// money integrity. Every test asserts the attack is BLOCKED. A failing test is a real hole.
// Attackers only use what `authenticated`/`anon` can execute and what RLS allows; fixtures that only
// server code could create are built as `postgres` (superuser) or through service-only *_at cores.
import { randomUUID } from 'node:crypto';
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

type Fx = GroupFixture & { pactId: string };

let db: DB;
let dayN = 0;
beforeEach(async () => {
  db = await createDb();
});

const LNG = -122.3035;
const latOf = (i: number) => 47.6553 + i * 0.01;
const HOME = { lat: 47.7, lng: -122.4 }; // ~6 km from every fixture place
const nowIso = () => new Date().toISOString();
const code = async (p: Promise<unknown>) => (await expectError(p)).code;
const denied = (p: Promise<unknown>) => expectError(p, /permission denied/);

async function fixture(members = 3, participants?: number): Promise<Fx> {
  const fx = (await createGroupFixture(db, { members, participants })) as Fx;
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  return fx;
}

/** Instance with window relative to real now() (minutes). */
async function mkInstance(pactId: string, openMin: number, deadlineMin: number, status = 'open', localDate?: string) {
  const ld = localDate ?? new Date(Date.UTC(2040, 0, 1 + dayN++)).toISOString().slice(0, 10);
  return scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
     values ($1, $2::date, now() + $3::float8 * interval '1 minute', now() + $4::float8 * interval '1 minute', $5::instance_status)
     returning id`,
    [pactId, ld, openMin, deadlineMin, status],
  );
}

/** Closed instance (real close + real payout). outcomes per participant index. */
async function closedInstance(fx: Fx, outcomes: ('success' | 'failed' | 'unverified')[]) {
  const inst = await mkInstance(fx.pactId, -120, -60, 'open');
  for (const [i, o] of outcomes.entries()) {
    if (o === 'failed') continue;
    await db.query(
      `select public.check_in_at($1, $2, $3, $4, $5, now() - interval '90 minutes', false, null, now() - interval '90 minutes')`,
      [fx.participantIds[i], inst, latOf(i), LNG, o === 'success' ? 10 : 250],
    );
  }
  await db.query(`select public.tick_instances(now())`);
  expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('closed');
  return inst;
}

const checkIn = (u: string, inst: string, lat: number | null, lng: number | null, acc: number | null, captured = nowIso(), attempt: string | null = null) =>
  asUser(db, u, async (d) =>
    (await d.query<any>(`select * from public.check_in($1, $2, $3, $4, $5::timestamptz, false, $6)`, [inst, lat, lng, acc, captured, attempt])).rows[0],
  );
const joinPact = (u: string, pact: string, lat: number, lng: number, r = 100) =>
  asUser(db, u, (d) => d.query(`select public.join_pact($1, $2, $3, $4, 'x')`, [pact, lat, lng, r]));
const openReview = (u: string, inst: string, subject: string, kind: 'appeal' | 'challenge') =>
  asUser(db, u, (d) => scalar<string>(d, `select public.open_review($1, $2, $3::review_kind, 'r', null)`, [inst, subject, kind]));
const vote = (u: string, review: string, s: boolean) =>
  asUser(db, u, (d) => d.query(`select public.cast_vote($1, $2)`, [review, s]));
const resultOf = (inst: string, u: string) =>
  scalar<string>(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [inst, u]);

// =============================================================================================
describe('check_in attacks', () => {
  it('cannot check in on someone else\'s behalf (no user parameter; the *_at core is not executable)', async () => {
    const fx = await fixture();
    const inst = await mkInstance(fx.pactId, -10, 50);
    const [a, b] = fx.participantIds;
    await asUser(db, b, (d) =>
      denied(d.query(`select public.check_in_at($1, $2, $3, $4, 10, now(), false, null, now())`, [a, inst, latOf(0), LNG])),
    );
    const r = await checkIn(b, inst, latOf(0), LNG, 10); // b standing at a's place
    expect(r.user_id).toBe(b);
    expect(r.verdict).toBe('out_of_fence'); // judged against b's own place
    expect(await scalar(db, `select count(*)::int from public.checkins where user_id = $1`, [a])).toBe(0);
  });

  it('cannot check in to an instance of a pact you are not in, or of another group', async () => {
    const fx = await fixture(4, 3);
    const inst = await mkInstance(fx.pactId, -10, 50);
    const notInPact = fx.userIds[3];
    expect(await code(checkIn(notInPact, inst, latOf(3), LNG, 10))).toBe('42501');
    const other = await fixture();
    expect(await code(checkIn(other.participantIds[0], inst, latOf(0), LNG, 10))).toBe('42501');
  });

  it('cannot spoof server time: no time parameter, client_captured_at bounded, server_received_at = now()', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    const future = await mkInstance(fx.pactId, 60, 120, 'scheduled');
    // claim the fix was captured inside the (future) window
    expect(await code(checkIn(a, future, latOf(0), LNG, 10, new Date(Date.now() + 90 * 60_000).toISOString()))).toBe('22023');
    expect(await code(checkIn(a, future, latOf(0), LNG, 10))).toBe('23514');
    const inst = await mkInstance(fx.pactId, -10, 50);
    const r = await checkIn(a, inst, latOf(0), LNG, 10, new Date(Date.now() - 3 * 3600_000).toISOString());
    expect(Math.abs(new Date(r.server_received_at).getTime() - Date.now())).toBeLessThan(60_000);
    // after the deadline, a late "offline" claim captured outside the window is refused
    const past = await mkInstance(fx.pactId, -120, -60, 'open');
    expect(await code(checkIn(a, past, latOf(0), LNG, 10, new Date(Date.now() - 30 * 60_000).toISOString()))).toBe('23514');
  });

  it('a late (offline) in-fence check-in never counts as success', async () => {
    const fx = await fixture();
    const inst = await closedInstance(fx, ['success', 'failed', 'failed']);
    const [, b] = fx.participantIds;
    await checkIn(b, inst, latOf(1), LNG, 10, new Date(Date.now() - 90 * 60_000).toISOString());
    expect(await resultOf(inst, b)).not.toBe('success');
  });

  it('flooding check_in with many attempt ids is capped', async () => {
    const fx = await fixture();
    const inst = await mkInstance(fx.pactId, -10, 50);
    const [a] = fx.participantIds;
    for (let i = 0; i < 60; i++) {
      try {
        await checkIn(a, inst, HOME.lat + i * 1e-4, HOME.lng, 5, nowIso(), randomUUID());
      } catch {
        /* a cap would reject here */
      }
    }
    const n = await scalar<number>(db, `select count(*)::int from public.checkins where user_id = $1 and instance_id = $2`, [a, inst]);
    expect(n, 'check-ins stored for one user on one instance').toBeLessThanOrEqual(20);
  });

  it('reusing another user\'s attempt id does not return their check-in', async () => {
    const fx = await fixture();
    const inst = await mkInstance(fx.pactId, -10, 50);
    const [a, b] = fx.participantIds;
    const id = randomUUID();
    await checkIn(a, inst, latOf(0), LNG, 10, nowIso(), id);
    const r = await checkIn(b, inst, HOME.lat, HOME.lng, 10, nowIso(), id);
    expect(r.user_id).toBe(b);
    expect(r.lat).toBe(HOME.lat);
  });
});

// =============================================================================================
describe('place / participation attacks', () => {
  it('cannot move your place while the window is open', async () => {
    const fx = await fixture();
    await mkInstance(fx.pactId, -10, 50);
    expect(await code(joinPact(fx.participantIds[0], fx.pactId, HOME.lat, HOME.lng))).toBe('23514');
  });

  it('cannot move your place once window_open_at has passed even if the tick has not opened it yet', async () => {
    const fx = await fixture();
    await mkInstance(fx.pactId, -1, 59, 'scheduled'); // cron lag: due but still 'scheduled'
    expect(await code(joinPact(fx.participantIds[0], fx.pactId, HOME.lat, HOME.lng))).toBe('23514');
  });

  it('moving your place to where you are right before the window does not let you check in from there', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    const inst = await mkInstance(fx.pactId, 1, 61, 'scheduled');
    await joinPact(a, fx.pactId, HOME.lat, HOME.lng).catch(() => undefined); // 1 minute before the window
    // time passes: the window opens
    await db.query(`update public.pact_instances set window_open_at = now() - interval '1 minute', status = 'open' where id = $1`, [inst]);
    const r = await checkIn(a, inst, HOME.lat, HOME.lng, 10).catch(() => null);
    expect(r?.verdict ?? 'blocked').not.toBe('in_fence');
  });

  it('cannot join a pact after its window opened to claim a win', async () => {
    const fx = await fixture(4, 3);
    const late = fx.userIds[3];
    const open = await mkInstance(fx.pactId, -10, 50);
    expect(await code(joinPact(late, fx.pactId, latOf(3), LNG))).toBe('23514');
    // cron lag: the join is refused (23514) or succeeds, but the instance never counts the late joiner
    await db.query(`update public.pact_instances set status = 'scheduled' where id = $1`, [open]);
    await joinPact(late, fx.pactId, latOf(3), LNG).catch((e) => expect(e.code).toBe('23514'));
    expect(await code(checkIn(late, open, latOf(3), LNG, 10))).toBe('42501');
    await db.query(`update public.pact_instances set deadline_at = now() - interval '1 second', status = 'open' where id = $1`, [open]);
    await db.query(`select public.tick_instances(now())`);
    expect(await resultOf(open, late)).toBeUndefined();
  });

  it('cannot dodge a loss by leaving the group mid-window (and rejoining afterwards)', async () => {
    const fx = await fixture();
    const [a, b] = fx.participantIds;
    const inst = await mkInstance(fx.pactId, -30, 30);
    await checkIn(a, inst, latOf(0), LNG, 10);
    // b knows they will miss: leave before the deadline (refused with 23514, or allowed but b still counts)
    await asUser(db, b, (d) => d.query(`select public.leave_group($1)`, [fx.groupId])).catch((e) => expect(e.code).toBe('23514'));
    await db.query(`update public.pact_instances set deadline_at = now() - interval '1 second' where id = $1`, [inst]);
    await db.query(`select public.tick_instances(now())`);
    // ...and come straight back
    await asUser(db, b, (d) => d.query(`select public.join_group($1)`, [fx.inviteCode]));
    await joinPact(b, fx.pactId, latOf(1), LNG);
    expect(await resultOf(inst, b)).toBe('failed');
    expect(
      await scalar<number>(db, `select coalesce(sum(balance_cents), 0)::int from public.member_balances where user_id = $1`, [b]),
    ).toBe(-500);
  });
});

// =============================================================================================
describe('freeze attacks', () => {
  it('cannot freeze after the window opened (also during cron lag)', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    const open = await mkInstance(fx.pactId, -10, 50);
    expect(await code(asUser(db, a, (d) => d.query(`select public.declare_freeze($1)`, [open])))).toBe('23514');
    const due = await mkInstance(fx.pactId, -1, 59, 'scheduled');
    expect(await code(asUser(db, a, (d) => d.query(`select public.declare_freeze($1)`, [due])))).toBe('23514');
  });

  it('cannot freeze twice in one ISO week via different instances', async () => {
    const fx = await fixture();
    const [a] = fx.participantIds;
    const mon = await mkInstance(fx.pactId, 60 * 24 * 400, 60 * 24 * 400 + 60, 'scheduled', '2031-01-06');
    const tue = await mkInstance(fx.pactId, 60 * 24 * 401, 60 * 24 * 401 + 60, 'scheduled', '2031-01-07');
    await asUser(db, a, (d) => d.query(`select public.declare_freeze($1)`, [mon]));
    expect(await code(asUser(db, a, (d) => d.query(`select public.declare_freeze($1)`, [tue])))).toBe('23514');
  });

  it('cannot freeze someone else, or an instance of a pact/group you are not in', async () => {
    const fx = await fixture(4, 3);
    const [a, b] = fx.participantIds;
    const inst = await mkInstance(fx.pactId, 600, 660, 'scheduled');
    await asUser(db, a, (d) => denied(d.query(`select public.declare_freeze_at($1, $2, now())`, [b, inst])));
    expect(await code(asUser(db, fx.userIds[3], (d) => d.query(`select public.declare_freeze($1)`, [inst])))).toBe('42501');
    const outsider = (await fixture()).participantIds[0];
    expect(await code(asUser(db, outsider, (d) => d.query(`select public.declare_freeze($1)`, [inst])))).toBe('42501');
    expect(await scalar(db, `select count(*)::int from public.freezes`)).toBe(0);
  });
});

// =============================================================================================
describe('review attacks', () => {
  it('appeal someone else\'s result / challenge your own / vote on your own appeal are refused', async () => {
    const fx = await fixture(4);
    const inst = await closedInstance(fx, ['success', 'success', 'failed', 'failed']);
    const [a, , c] = fx.participantIds;
    expect(await code(openReview(a, inst, c, 'appeal'))).toBe('42501');
    expect(await code(openReview(a, inst, a, 'challenge'))).toBe('42501');
    const r = await openReview(c, inst, c, 'appeal');
    expect(await code(vote(c, r, true))).toBe('42501');
  });

  it('voting twice counts once; non-participants and outsiders cannot vote; no votes after resolution', async () => {
    const fx = await fixture(5, 4);
    const inst = await closedInstance(fx, ['success', 'success', 'failed', 'failed']);
    const [a, b, c] = fx.participantIds;
    const r = await openReview(c, inst, c, 'appeal'); // eligible voters: a, b, d (3)
    await vote(a, r, true);
    await vote(a, r, true);
    expect(await scalar(db, `select count(*)::int from public.review_votes where review_id = $1`, [r])).toBe(1);
    expect(await scalar(db, `select status::text from public.reviews where id = $1`, [r])).toBe('open');
    expect(await code(vote(fx.userIds[4], r, true))).toBe('42501'); // group member, not in pact
    const outsider = await createUser(db);
    expect(await code(vote(outsider, r, true))).toBe('42501');
    await vote(b, r, true); // 2 of 3 -> accepted
    expect(await scalar(db, `select status::text from public.reviews where id = $1`, [r])).toBe('accepted');
    expect(await code(vote(fx.participantIds[3], r, false))).toBe('23514');
  });

  it('cannot open a review on a settled (or open/voided) instance', async () => {
    const fx = await fixture();
    const inst = await closedInstance(fx, ['success', 'failed', 'failed']);
    await db.query(`update public.pact_instances set status = 'settled' where id = $1`, [inst]);
    expect(await code(openReview(fx.participantIds[1], inst, fx.participantIds[1], 'appeal'))).toBe('23514');
    expect(await code(openReview(fx.participantIds[1], inst, fx.participantIds[0], 'challenge'))).toBe('23514');
  });

  it('cannot re-appeal after the group rejected the appeal', async () => {
    const fx = await fixture(4);
    const inst = await closedInstance(fx, ['success', 'success', 'failed', 'failed']);
    const [a, b, c] = fx.participantIds;
    const r1 = await openReview(c, inst, c, 'appeal');
    await vote(a, r1, false);
    await vote(b, r1, false);
    expect(await scalar(db, `select status::text from public.reviews where id = $1`, [r1])).toBe('rejected');
    expect(await code(openReview(c, inst, c, 'appeal'))).toBe('23514');
  });

  it('appealing every loss and hoping nobody votes costs exactly what the loss cost (N3-1: a defaulted appeal is not "excluded")', async () => {
    const fx = await fixture(4);
    const inst = await closedInstance(fx, ['success', 'success', 'failed', 'failed']);
    const [a, , c, d] = fx.participantIds;
    const control = await closedInstance(fx, ['success', 'success', 'failed', 'failed']);
    const balance = (u: string) => scalar<number>(db, `select balance_cents::int from public.member_balances where user_id = $1`, [u]);
    expect(await balance(c)).toBe(-1000);
    await openReview(c, inst, c, 'appeal'); // Sunday night, nobody votes
    await openReview(c, control, c, 'appeal');
    await asService(db, (d) => d.query(`select public.default_open_reviews($1, now() + interval '1 day')`, [fx.groupId]));
    expect(await rows(db, `select status::text from public.reviews where subject_user_id = $1`, [c])).toEqual([{ status: 'defaulted' }, { status: 'defaulted' }]);
    expect(await resultOf(inst, c)).toBe('failed');
    expect(await resultOf(control, c)).toBe('failed');
    expect(await balance(c)).toBe(-1000); // both forfeits stand
    expect(await balance(d)).toBe(-1000); // and the non-appealing loser is no worse off than the appealing one
    expect(await balance(a)).toBe(1000); // 500 from each instance's pot
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction'`)).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.results where status = 'excluded'`)).toBe(0);
    expect(await code(openReview(c, inst, c, 'appeal'))).toBe('23514'); // and it cannot be retried
  });

  it('a rejected appeal cannot be turned into "excluded" by re-appealing and waiting for the default', async () => {
    const fx = await fixture(4);
    const inst = await closedInstance(fx, ['success', 'success', 'failed', 'failed']);
    const [a, b, c] = fx.participantIds;
    const r1 = await openReview(c, inst, c, 'appeal');
    await vote(a, r1, false);
    await vote(b, r1, false);
    await openReview(c, inst, c, 'appeal').catch(() => undefined); // late Sunday night, nobody votes
    await asService(db, (d) => d.query(`select public.default_open_reviews($1, now() + interval '1 day')`, [fx.groupId]));
    expect(await resultOf(inst, c)).toBe('failed');
    expect(await scalar<number>(db, `select balance_cents::int from public.member_balances where user_id = $1`, [c])).toBe(-500);
  });

  it('someone who joins the pact after the instance cannot vote on its reviews', async () => {
    const fx = await fixture(4, 3);
    const inst = await closedInstance(fx, ['success', 'failed', 'success']);
    const [a, b] = fx.participantIds;
    const d = fx.userIds[3];
    const r = await openReview(b, inst, b, 'appeal'); // eligible: a, c
    await vote(a, r, true); // 1 of 2: not a majority
    await joinPact(d, fx.pactId, latOf(3), LNG); // allowed: no window open
    expect(await code(vote(d, r, true))).toBe('42501');
    expect(await resultOf(inst, b)).toBe('failed');
  });
});

// =============================================================================================
describe('obligation attacks', () => {
  async function obligations() {
    const fx = await fixture(4);
    const [a, b, c, e] = fx.userIds;
    const s = await scalar<string>(db, `insert into public.settlements (group_id, week_start) values ($1, '2030-01-07') returning id`, [fx.groupId]);
    const live = await scalar<string>(
      db, `insert into public.obligations (settlement_id, group_id, from_user, to_user, amount_cents) values ($1, $2, $3, $4, 500) returning id`,
      [s, fx.groupId, b, a]);
    const old = await scalar<string>(
      db, `insert into public.obligations (settlement_id, group_id, from_user, to_user, amount_cents, status) values ($1, $2, $3, $4, 300, 'superseded') returning id`,
      [s, fx.groupId, c, a]);
    return { fx, a, b, c, e, live, old };
  }
  const mark = (u: string, o: string) => asUser(db, u, (d) => d.query(`select public.mark_obligation_paid($1)`, [o]));
  const confirm = (u: string, o: string) => asUser(db, u, (d) => d.query(`select public.confirm_obligation($1)`, [o]));

  it('payee cannot mark paid; payer cannot confirm; third parties can do neither', async () => {
    const { a, b, c, live } = await obligations();
    const outsider = await createUser(db);
    expect(await code(mark(a, live))).toBe('42501');
    expect(await code(confirm(b, live))).toBe('42501');
    for (const u of [c, outsider]) {
      expect(await code(mark(u, live))).toBe('42501');
      expect(await code(confirm(u, live))).toBe('42501');
    }
    expect(await scalar(db, `select status::text from public.obligations where id = $1`, [live])).toBe('pending');
    expect(await scalar(db, `select count(*)::int from public.ledger_entries`)).toBe(0);
  });

  it('superseded obligations cannot be confirmed (twice); a confirmation posts exactly once', async () => {
    const { a, b, live, old } = await obligations();
    expect(await code(confirm(a, old))).toBe('23514');
    expect(await code(confirm(a, old))).toBe('23514');
    await mark(b, live);
    await confirm(a, live);
    await confirm(a, live);
    await mark(b, live);
    expect(await scalar(db, `select count(*)::int from public.ledger_entries where kind = 'settlement_payment'`)).toBe(1);
    expect(await scalar(db, `select status::text from public.obligations where id = $1`, [live])).toBe('confirmed');
  });
});

// =============================================================================================
const TABLE_COL: Record<string, string> = {
  profiles: 'created_at', groups: 'name', group_members: 'role', pacts: 'paused', pact_participants: 'place_lat',
  pact_instances: 'status', checkins: 'verdict', freezes: 'iso_week', results: 'status', reviews: 'status',
  review_votes: 'supports', ledger_accounts: 'kind', ledger_entries: 'memo', ledger_lines: 'amount_cents',
  settlements: 'ran_at', obligations: 'status', notification_outbox: 'sent_at', push_tokens: 'platform',
};

describe('direct table writes as authenticated', () => {
  it('INSERT / UPDATE / DELETE / TRUNCATE on every table are denied (except own profile columns and own push tokens)', async () => {
    const fx = await fixture();
    await closedInstance(fx, ['success', 'failed', 'failed']);
    const [a] = fx.participantIds;
    for (const [t, col] of Object.entries(TABLE_COL)) {
      await asUser(db, a, async (d) => {
        await denied(d.query(`insert into public.${t} default values`));
        if (t !== 'push_tokens') await denied(d.query(`delete from public.${t}`));
        await denied(d.query(`update public.${t} set ${col} = ${col}`));
        await denied(d.query(`truncate public.${t}`));
      });
    }
    await asUser(db, a, async (d) => {
      await denied(d.query(`select nextval('public.ledger_lines_id_seq')`));
      await denied(d.query(`select nextval('public.notification_outbox_id_seq')`));
      await expectError(d.query(`insert into public.member_balances (group_id, user_id, balance_cents) values ($1, $2, 1)`, [fx.groupId, a]));
      await denied(d.query(`update public.profiles set id = id where id = $1`, [a]));
    });
  });

  it('profile edits only reach your own row; push token deletes only your own', async () => {
    const fx = await fixture();
    const [a, b] = fx.userIds;
    await asUser(db, b, (d) => d.query(`select public.register_push_token('ExponentPushToken[victim]', 'ios')`));
    await asUser(db, a, async (d) => {
      await d.query(`update public.profiles set display_name = 'pwned', venmo_username = 'attacker-1' where id = $1`, [b]);
      await d.query(`delete from public.push_tokens`);
    });
    expect(await rows(db, `select display_name, venmo_username from public.profiles where id = $1`, [b])).toEqual([
      { display_name: 'Member 2', venmo_username: null },
    ]);
    expect(await scalar(db, `select count(*)::int from public.push_tokens where user_id = $1`, [b])).toBe(1);
  });

  it('profile length / format limits hold', async () => {
    const fx = await fixture(1, 1);
    const [a] = fx.userIds;
    await asUser(db, a, async (d) => {
      expect((await expectError(d.query(`update public.profiles set display_name = repeat('x', 100000) where id = $1`, [a]))).code).toBe('23514');
      expect((await expectError(d.query(`update public.profiles set display_name = '   ' where id = $1`, [a]))).code).toBe('23514');
      expect((await expectError(d.query(`update public.profiles set venmo_username = repeat('a', 1000) where id = $1`, [a]))).code).toBe('23514');
      expect((await expectError(d.query(`update public.profiles set venmo_username = 'x; drop' where id = $1`, [a]))).code).toBe('23514');
    });
  });
});

// =============================================================================================
const READ_TABLES = [
  'pacts', 'pact_participants', 'pact_instances', 'checkins', 'freezes', 'results', 'reviews', 'review_votes',
  'ledger_accounts', 'ledger_entries', 'ledger_lines', 'settlements', 'obligations', 'notification_outbox',
  'push_tokens', 'account_balances', 'member_balances',
];

describe('cross-group reads', () => {
  async function victimGroup() {
    const fx = await fixture(4);
    const inst = await closedInstance(fx, ['success', 'success', 'failed', 'unverified']);
    const [a, b, , d] = fx.participantIds;
    const r = await openReview(a, inst, d, 'challenge');
    await vote(b, r, true);
    const fut = await mkInstance(fx.pactId, 600, 660, 'scheduled');
    await asUser(db, a, (x) => x.query(`select public.declare_freeze($1)`, [fut]));
    await asUser(db, b, (x) => x.query(`select public.register_push_token('ExponentPushToken[b]', 'ios')`));
    await db.query(`select public.settle_due_groups(now() + interval '8 days')`);
    for (const t of READ_TABLES) {
      expect(await scalar<number>(db, `select count(*)::int from public.${t}`), `fixture has ${t}`).toBeGreaterThan(0);
    }
    return { fx, inst };
  }

  it('a member of another group (and a groupless user) sees nothing of the victim group', async () => {
    const { fx } = await victimGroup();
    const z = await createUser(db);
    const zGroup = await asUser(db, z, (d) => scalar<string>(d, `select public.create_group('mine', 'UTC')`));
    const loner = await createUser(db);
    for (const u of [z, loner]) {
      await asUser(db, u, async (d) => {
        for (const t of READ_TABLES) {
          expect(await scalar<number>(d, `select count(*)::int from public.${t}`), t).toBe(0);
        }
        expect(await scalar<number>(d, `select count(*)::int from public.profiles where id <> $1`, [u])).toBe(0);
        expect(await scalar<number>(d, `select count(*)::int from public.groups where id = $1`, [fx.groupId])).toBe(0);
        expect(await scalar<number>(d, `select count(*)::int from public.group_members where group_id = $1`, [fx.groupId])).toBe(0);
      });
    }
    expect(zGroup).toBeTruthy();
  });

  it('members see only their own push tokens and outbox rows', async () => {
    const { fx } = await victimGroup();
    const [a] = fx.userIds;
    await asUser(db, a, async (d) => {
      expect(await scalar<number>(d, `select count(*)::int from public.push_tokens where user_id <> $1`, [a])).toBe(0);
      expect(await scalar<number>(d, `select count(*)::int from public.notification_outbox where user_id <> $1`, [a])).toBe(0);
    });
  });

  it('a former member can no longer read the group\'s GPS check-ins, places, results or ledger', async () => {
    const { fx } = await victimGroup();
    const c = fx.userIds[2];
    expect(await asUser(db, c, (d) => scalar<number>(d, `select count(*)::int from public.checkins where lat is not null`))).toBeGreaterThan(0);
    await asUser(db, c, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    await asUser(db, c, async (d) => {
      for (const t of ['checkins', 'pact_participants', 'pact_instances', 'results', 'reviews', 'review_votes', 'ledger_lines', 'ledger_entries', 'freezes']) {
        expect(await scalar<number>(d, `select count(*)::int from public.${t}`), t).toBe(0);
      }
    });
  });

  it('anon can read no table', async () => {
    await victimGroup();
    await asAnon(db, async (d) => {
      for (const t of [...READ_TABLES, 'profiles', 'groups', 'group_members']) await denied(d.query(`select 1 from public.${t} limit 1`));
    });
  });
});

// =============================================================================================
const SERVICE_ONLY: [string, string[]][] = [
  ['generate_instances', ['int', 'timestamptz']],
  ['tick_instances', ['timestamptz']],
  ['settle_due_groups', ['timestamptz']],
  ['post_instance_payout', ['uuid']],
  ['apply_instance_correction', ['uuid']],
  ['default_open_reviews', ['uuid', 'timestamptz']],
  ['purge_old_locations', ['timestamptz']],
  ['claim_outbox', ['int', 'timestamptz']],
  ['post_entry', ['uuid', 'public.entry_kind', 'text', 'uuid', 'text', 'jsonb']],
  ['ensure_account', ['uuid', 'public.ledger_account_kind', 'uuid', 'uuid', 'uuid']],
  ['check_in_at', ['uuid', 'uuid', 'float8', 'float8', 'float8', 'timestamptz', 'boolean', 'uuid', 'timestamptz']],
  ['declare_freeze_at', ['uuid', 'uuid', 'timestamptz']],
  ['open_review_at', ['uuid', 'uuid', 'uuid', 'public.review_kind', 'text', 'text', 'timestamptz']],
  ['cast_vote_at', ['uuid', 'uuid', 'boolean', 'timestamptz']],
  ['gen_invite_code', []],
  ['_close_instance', ['uuid', 'timestamptz']],
  ['_refresh_result', ['uuid', 'uuid', 'timestamptz']],
  ['_resolve_review', ['uuid', 'public.review_status', 'timestamptz']],
  ['_base_result', ['uuid', 'uuid']],
  ['_instance_participants', ['uuid']],
  ['_instance_payload', ['uuid', 'uuid']],
  ['_payout_plan', ['uuid', 'bigint']],
  ['_post_initial', ['uuid', 'uuid', 'uuid']],
  ['_correct_instance', ['uuid', 'uuid', 'uuid', 'uuid']],
  ['_settle_group_week', ['uuid', 'date', 'timestamptz', 'timestamptz']],
  ['_review_voters', ['uuid']],
  ['_lock_pact_carry', ['uuid', 'uuid']],
  ['_account_balance', ['uuid']],
  ['_instance_posted', ['uuid']],
  ['_local_to_utc', ['timestamp', 'text']],
  ['_haversine_m', ['float8', 'float8', 'float8', 'float8']],
];
const CLIENT_RPCS: [string, string[]][] = [
  ['create_group', ['text', 'text']], ['join_group', ['text']], ['leave_group', ['uuid']],
  ['create_pact', ['uuid', 'text', 'smallint[]', 'time', 'time', 'int', 'text']],
  ['join_pact', ['uuid', 'float8', 'float8', 'int', 'text']], ['set_pact_paused', ['uuid', 'boolean']],
  ['check_in', ['uuid', 'float8', 'float8', 'float8', 'timestamptz', 'boolean', 'uuid']], ['declare_freeze', ['uuid']],
  ['open_review', ['uuid', 'uuid', 'public.review_kind', 'text', 'text']], ['cast_vote', ['uuid', 'boolean']],
  ['mark_obligation_paid', ['uuid']], ['confirm_obligation', ['uuid']], ['dispute_obligation', ['uuid']],
  ['register_push_token', ['text', 'text']],
  ['acknowledge_place', ['uuid']], ['object_place', ['uuid', 'text']], ['pact_place_distances', ['uuid']],
];
const callSql = (fn: string, types: string[]) => `select public.${fn}(${types.map((t) => `null::${t}`).join(', ')})`;

describe('service-only functions', () => {
  it('every server job / internal core is denied to authenticated and anon', async () => {
    const u = await createUser(db);
    for (const [fn, types] of SERVICE_ONLY) {
      await asUser(db, u, (d) => denied(d.query(callSql(fn, types))));
      await asAnon(db, (d) => denied(d.query(callSql(fn, types))));
    }
    for (const [fn, types] of CLIENT_RPCS) await asAnon(db, (d) => denied(d.query(callSql(fn, types))));
  });

  it('catalog sweep: no SECURITY DEFINER function beyond the RPC allowlist is executable by clients', async () => {
    const allow = new Set([
      ...CLIENT_RPCS.map(([f]) => f),
      'is_group_member', 'is_pact_participant', 'is_pact_group_member', 'is_instance_group_member', 'shares_group_with',
    ]);
    const fns = await rows<{ name: string; secdef: boolean; auth: boolean; anon: boolean }>(
      db,
      `select p.proname as name, p.prosecdef as secdef,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
    );
    expect(fns.filter((f) => f.secdef && f.anon).map((f) => f.name)).toEqual([]);
    expect(fns.filter((f) => f.secdef && f.auth && !allow.has(f.name)).map((f) => f.name)).toEqual([]);
    // _place_row_at is the one underscore helper a client role may run: the security-invoker view
    // pact_places_visible calls it as the member and it reads only RLS-visible rows (N1-7, NI-1).
    // It must stay a plain function (never SECURITY DEFINER) and must never reach anon.
    const helperException = new Set(['_place_row_at']);
    expect(fns.filter((f) => f.name.startsWith('_') && !helperException.has(f.name) && (f.auth || f.anon)).map((f) => f.name)).toEqual([]);
    for (const name of helperException) {
      expect(fns.find((f) => f.name === name), name).toMatchObject({ secdef: false, anon: false });
    }
  });
});

// =============================================================================================
describe('role escalation and membership', () => {
  it('cannot join a full group (8 members)', async () => {
    const fx = await fixture(8, 1);
    const ninth = await createUser(db);
    expect(await code(asUser(db, ninth, (d) => d.query(`select public.join_group($1)`, [fx.inviteCode])))).toBe('23514');
  });

  it('cannot become owner, remove members, or pause someone else\'s pact', async () => {
    const fx = await fixture(3);
    const [owner, m] = fx.userIds;
    await asUser(db, m, async (d) => {
      await denied(d.query(`update public.group_members set role = 'owner' where user_id = $1`, [m]));
      await denied(d.query(`delete from public.group_members where user_id = $1`, [owner]));
      await denied(d.query(`update public.group_members set left_at = now() where user_id = $1`, [owner]));
    });
    expect(await code(asUser(db, m, (d) => d.query(`select public.set_pact_paused($1, true)`, [fx.pactId])))).toBe('42501');
    const outsider = (await fixture(1, 1)).userIds[0];
    expect(await code(asUser(db, outsider, (d) => d.query(`select public.set_pact_paused($1, true)`, [fx.pactId])))).toBe('42501');
    expect(await code(asUser(db, outsider, (d) => d.query(`select public.leave_group($1)`, [fx.groupId])))).toBe('42501');
    expect(await code(joinPact(outsider, fx.pactId, 0, 0))).toBe('42501');
    expect(await code(asUser(db, outsider, (d) => d.query(`select public.create_pact($1, 't', '{1}', '08:00', '09:00', 500, 'UTC')`, [fx.groupId])))).toBe('42501');
    expect(await scalar(db, `select paused from public.pacts where id = $1`, [fx.pactId])).toBe(false);
  });

  it('a former owner who rejoins with the old invite is a plain member and not back in the pact', async () => {
    const fx = await fixture(3);
    const [owner, m] = fx.userIds;
    await asUser(db, owner, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    expect(await scalar(db, `select role from public.group_members where group_id = $1 and user_id = $2`, [fx.groupId, m])).toBe('owner');
    await asUser(db, owner, (d) => d.query(`select public.join_group($1)`, [fx.inviteCode.toLowerCase()]));
    expect(await scalar(db, `select role from public.group_members where group_id = $1 and user_id = $2`, [fx.groupId, owner])).toBe('member');
    expect(await scalar(db, `select left_at is not null from public.pact_participants where pact_id = $1 and user_id = $2`, [fx.pactId, owner])).toBe(true);
  });

  it('invite codes have 50 bits of entropy and cannot be guessed or wildcarded', async () => {
    const r = await rows<{ n: number; d: number; minl: number; maxl: number; bad: number }>(
      db,
      `select count(*)::int n, count(distinct c)::int d, min(length(c)) minl, max(length(c)) maxl,
              count(*) filter (where c !~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$')::int bad
         from (select public.gen_invite_code() c from generate_series(1, 3000)) s`,
    );
    expect(r[0]).toEqual({ n: 3000, d: 3000, minl: 10, maxl: 10, bad: 0 });
    // every symbol position uses all 32 symbols (uniform 5 bits each)
    expect(
      await scalar<number>(db, `select count(distinct substr(c, 1, 1))::int from (select public.gen_invite_code() c from generate_series(1, 3000)) s`),
    ).toBe(32);
    const fx = await fixture(1, 1);
    const u = await createUser(db);
    for (const guess of ['%', '_', '0000000000', fx.inviteCode.slice(0, 9), `${fx.inviteCode}' or '1'='1`, '']) {
      expect(await code(asUser(db, u, (d) => d.query(`select public.join_group($1)`, [guess])))).toBe('P0002');
    }
  });
});
