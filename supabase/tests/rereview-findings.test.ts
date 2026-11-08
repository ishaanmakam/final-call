import { beforeEach, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createGroupFixture, expectError, rows, scalar, type DB } from './helpers/db';

// Re-review of the fixes in a5dab30. Every test asserts the CORRECT behaviour and is expected to
// FAIL against the current migrations, for the reason given in its comment.

const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();
const placeOf = (i: number) => ({ lat: 47.6553 + i * 0.01, lng: -122.3035 });

async function checkInAt(db: DB, user: string, instance: string, i: number, now: string, captured?: string) {
  const p = placeOf(i);
  const r = await db.query<any>(
    `select * from public.check_in_at($1, $2, $3, $4, 10, $5::timestamptz, false, null, $6::timestamptz)`,
    [user, instance, p.lat, p.lng, captured ?? now, now],
  );
  return r.rows[0];
}
const gen = (db: DB, now: string) => db.query(`select public.generate_instances(7, $1::timestamptz)`, [now]);
const tick = (db: DB, now: string) => db.query(`select public.tick_instances($1::timestamptz)`, [now]);
const settle = (db: DB, now: string) =>
  asService(db, (d) => scalar<number>(d, `select public.settle_due_groups($1::timestamptz)`, [now]));
const instanceId = (db: DB, pactId: string, date: string) =>
  scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);
const net = async (db: DB, inst: string, user: string) =>
  Number(
    await scalar(
      db,
      `select coalesce(sum(l.amount_cents), 0)::bigint from public.ledger_lines l
         join public.ledger_entries e on e.id = l.entry_id join public.ledger_accounts a on a.id = l.account_id
        where e.instance_id = $1 and a.kind = 'member' and a.user_id = $2`,
      [inst, user],
    ),
  );

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

describe('late check-ins on settled instances', () => {
  // Sunday pact 18:00-19:00 America/Los_Angeles. Sunday 2030-01-13 (PST): window 2030-01-14T02:00Z,
  // deadline 03:00Z. Week Mon 01-07..Sun 01-13 settles Mon 01-14 12:00 PST = 20:00Z. Late offline
  // taps are accepted until deadline + 24h = 2030-01-15T03:00Z, i.e. for 7 hours AFTER settlement.
  const OPEN = '2030-01-14T02:00:00.000Z';
  const DEADLINE = '2030-01-14T03:00:00.000Z';
  const SETTLE = '2030-01-14T20:00:00.000Z';

  it('a result changed by a late tap after settlement can still be challenged (DECISIONS open question 5: "the only defence is a challenge")', async () => {
    const fx = await createGroupFixture(db, { members: 3, pact: { days: [7], windowOpen: '18:00', deadline: '19:00' } });
    const pact = fx.pactId!;
    const [a, b, c] = fx.participantIds;
    await db.query(`update public.groups set created_at = '2030-01-08Z' where id = $1`, [fx.groupId]);
    await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pact]);
    await db.query(`update public.pact_participant_places set effective_from = '2020-01-01Z' where pact_id = $1`, [pact]);

    await gen(db, '2030-01-13T12:00:00Z');
    const sun = await instanceId(db, pact, '2030-01-13');
    await tick(db, OPEN);
    await checkInAt(db, a, sun, 0, at(OPEN, 10));
    await checkInAt(db, b, sun, 1, at(OPEN, 10));
    await tick(db, DEADLINE);
    expect(await net(db, sun, c)).toBe(-500);
    await settle(db, SETTLE);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [sun])).toBe('settled');

    // Monday 13:00 PST, an hour after settlement: c stands at the place now and submits a tap with a
    // forged capture time inside Sunday's window. Accepted, result -> unverified, c refunded.
    await checkInAt(db, c, sun, 2, at(SETTLE, 60), at(OPEN, 30));
    expect(await scalar(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [sun, c])).toBe('unverified');
    expect(await net(db, sun, c)).toBe(0);

    // BUG: open_review_at requires status 'closed', so the change is final and unreviewable
    // (23514 'only closed, unsettled instances can be reviewed').
    const rev = await db.query(
      `select public.open_review_at($1, $2, $3, 'challenge', 'tap captured 17h before it arrived', null, $4::timestamptz)`,
      [a, sun, c, at(SETTLE, 90)],
    );
    expect(rev.rows.length).toBe(1);
  });
});

describe('roster: pause, leave, resume', () => {
  it('leaving while a paused pact has a due-but-unopened instance does not leave you on its roster after a resume', async () => {
    const fx = await createGroupFixture(db, { members: 3 });
    const pact = fx.pactId!;
    const [, , c] = fx.participantIds;
    await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pact]);
    // window opened a minute ago; the tick has not run yet (cron lag)
    const inst = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
       values ($1, '2099-01-01', now() - interval '1 minute', now() + interval '59 minutes', 'scheduled') returning id`,
      [pact],
    );
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [pact]));

    // leave_group skips paused pacts ("the tick will void it") ...
    let left = true;
    try {
      await asUser(db, c, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    } catch (e: any) {
      expect(e.code).toBe('23514');
      left = false;
    }
    if (left) {
      // ... but a resume before the tick means the instance opens with c still on its roster
      // (left_at > window_open_at), so c is scored (failed, -stake) in a group c has left.
      await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, false)`, [pact]));
      await tick(db, new Date().toISOString());
      const roster = (await rows<{ u: string }>(db, `select u::text from public._instance_participants($1) u`, [inst])).map((r) => r.u);
      expect(roster).not.toContain(c);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fixes for the findings above, plus the related follow-ups (voters who left, late-tap void rule).
// ---------------------------------------------------------------------------------------------

// Sunday pact 18:00-19:00 America/Los_Angeles; Sunday 2030-01-13 closes at 03:00Z on 01-14 and
// its week settles 2030-01-14T20:00Z; the next week settles 2030-01-21T20:00Z.
const S_OPEN = '2030-01-14T02:00:00.000Z';
const S_DEADLINE = '2030-01-14T03:00:00.000Z';
const S_SETTLE = '2030-01-14T20:00:00.000Z';
const S_SETTLE_NEXT = '2030-01-21T20:00:00.000Z';

// Closed Sunday instance; members[i] checks in on time iff succeed[i].
async function sundayClosed(members: number, succeed: boolean[]) {
  const fx = await createGroupFixture(db, { members, pact: { days: [7], windowOpen: '18:00', deadline: '19:00' } });
  const pact = fx.pactId!;
  await db.query(`update public.groups set created_at = '2030-01-08Z' where id = $1`, [fx.groupId]);
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pact]);
  await db.query(`update public.pact_participant_places set effective_from = '2020-01-01Z' where pact_id = $1`, [pact]);
  await gen(db, '2030-01-13T12:00:00Z');
  const sun = await instanceId(db, pact, '2030-01-13');
  await tick(db, S_OPEN);
  for (let i = 0; i < members; i++) if (succeed[i]) await checkInAt(db, fx.participantIds[i], sun, i, at(S_OPEN, 10));
  await tick(db, S_DEADLINE);
  return { fx, sun, u: fx.participantIds };
}
const openReview = (user: string, inst: string, subject: string, kind: 'appeal' | 'challenge', now: string) =>
  scalar<string>(db, `select public.open_review_at($1, $2, $3, $4::public.review_kind, 'r', null, $5::timestamptz)`, [user, inst, subject, kind, now]);
const vote = (user: string, review: string, supports: boolean, now: string) =>
  db.query(`select public.cast_vote_at($1, $2, $3, $4::timestamptz)`, [user, review, supports, now]);
const reviewStatus = (review: string) => scalar<string>(db, `select status::text from public.reviews where id = $1`, [review]);
const resultOf = (inst: string, user: string) =>
  scalar<string>(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [inst, user]);

describe('fix 1: challenges of results changed by a late tap after settlement', () => {
  it('stamps settled_at when settlement marks an instance settled', async () => {
    const { sun } = await sundayClosed(3, [true, true, false]);
    await settle(db, S_SETTLE);
    const r = await rows<{ status: string; settled_at: Date }>(db, `select status::text, settled_at from public.pact_instances where id = $1`, [sun]);
    expect(r[0].status).toBe('settled');
    expect(r[0].settled_at.toISOString()).toBe(S_SETTLE);
  });

  it('refuses a challenge on a settled instance whose result did not change after settlement', async () => {
    const { sun, u } = await sundayClosed(3, [true, true, false]);
    await settle(db, S_SETTLE);
    await expectError(openReview(u[0], sun, u[1], 'challenge', at(S_SETTLE, 30)), /closed, unsettled|changed after settlement/);
  });

  it('allows votes on the late challenge; an appeal of the overturned result is still refused on the settled instance', async () => {
    const { sun, u } = await sundayClosed(3, [true, true, false]);
    const [a, b, c] = u;
    await settle(db, S_SETTLE);
    await checkInAt(db, c, sun, 2, at(S_SETTLE, 60), at(S_OPEN, 30));
    expect(await resultOf(sun, c)).toBe('unverified');
    const rev = await openReview(a, sun, c, 'challenge', at(S_SETTLE, 90));
    expect((await expectError(vote(a, rev, true, at(S_SETTLE, 91)))).code).toBe('42501'); // the opener does not vote (RT-1)
    expect(await reviewStatus(rev)).toBe('open');
    await vote(b, rev, true, at(S_SETTLE, 92)); // b is the only eligible voter
    expect(await reviewStatus(rev)).toBe('accepted');
    expect(await resultOf(sun, c)).toBe('failed');
    expect(await net(db, sun, c)).toBe(-500);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [sun])).toBe('settled');
    // c's result was decided after settlement, but appeals stay closed on settled instances
    const e = await expectError(openReview(c, sun, c, 'appeal', at(S_SETTLE, 120)));
    expect(e.code).toBe('23514');
  });

  it('an unresolved late challenge is resolved at the next settlement and its correction billed then', async () => {
    const { fx, sun, u } = await sundayClosed(4, [true, true, true, false]);
    const [a, b, , c] = u;
    await settle(db, S_SETTLE);
    await checkInAt(db, c, sun, 3, at(S_SETTLE, 60), at(S_OPEN, 30));
    const rev = await openReview(a, sun, c, 'challenge', at(S_SETTLE, 90));
    await vote(b, rev, true, at(S_SETTLE, 91)); // 1 of 2 eligible (b, d; the opener a does not vote): not a majority yet
    expect(await reviewStatus(rev)).toBe('open');
    expect(await net(db, sun, c)).toBe(0);

    expect(await settle(db, S_SETTLE_NEXT)).toBe(1);
    expect(await reviewStatus(rev)).toBe('accepted'); // 1 yes, 0 no among votes cast
    expect(await resultOf(sun, c)).toBe('failed');
    expect(await net(db, sun, c)).toBe(-500);
    const owed = await scalar<number>(
      db,
      `select coalesce(sum(o.amount_cents), 0)::int from public.obligations o
         join public.settlements s on s.id = o.settlement_id
        where o.group_id = $1 and s.week_start = '2030-01-14' and o.from_user = $2 and o.status = 'pending'`,
      [fx.groupId, c],
    );
    expect(owed).toBe(500);
  });
});

describe('fix 2: leave_group while a paused pact has a due-but-unopened instance', () => {
  it('is refused until the tick voids the instance, then allowed', async () => {
    const fx = await createGroupFixture(db, { members: 3 });
    const pact = fx.pactId!;
    const [, , c] = fx.participantIds;
    await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pact]);
    const inst = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
       values ($1, '2099-01-01', now() - interval '1 minute', now() + interval '59 minutes', 'scheduled') returning id`,
      [pact],
    );
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [pact]));
    const e = await expectError(asUser(db, c, (d) => d.query(`select public.leave_group($1)`, [fx.groupId])));
    expect(e.code).toBe('23514');
    await tick(db, new Date().toISOString());
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('voided');
    await asUser(db, c, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    expect(await scalar(db, `select left_at is not null from public.group_members where group_id = $1 and user_id = $2`, [fx.groupId, c])).toBe(true);
  });
});

describe('fix 3: voters who left the group', () => {
  it('cannot vote and do not count as eligible', async () => {
    const { fx, sun, u } = await sundayClosed(5, [true, true, false, false, false]);
    const [a, b, c, d] = u;
    const rev = await openReview(a, sun, b, 'challenge', at(S_DEADLINE, 10));
    await asUser(db, d, (x) => x.query(`select public.leave_group($1)`, [fx.groupId]));
    const e = await expectError(vote(d, rev, true, at(S_DEADLINE, 11)));
    expect(e.code).toBe('42501');
    // eligible = c, e (d left; the opener a does not vote, RT-1): two yes votes are a majority
    expect((await expectError(vote(a, rev, true, at(S_DEADLINE, 12)))).code).toBe('42501');
    await vote(c, rev, true, at(S_DEADLINE, 12));
    expect(await reviewStatus(rev)).toBe('open');
    await vote(u[4], rev, true, at(S_DEADLINE, 13));
    expect(await reviewStatus(rev)).toBe('accepted');
    expect(await resultOf(sun, b)).toBe('failed');
  });

  it('a vote cast before leaving is not counted when the review is defaulted at settlement', async () => {
    const { fx, sun, u } = await sundayClosed(5, [true, true, false, false, false]);
    const [a, b, c, d] = u;
    const rev = await openReview(a, sun, b, 'challenge', at(S_DEADLINE, 10));
    await vote(d, rev, false, at(S_DEADLINE, 11));
    await asUser(db, d, (x) => x.query(`select public.leave_group($1)`, [fx.groupId]));
    await vote(c, rev, true, at(S_DEADLINE, 12)); // 1 of 2 eligible (c, e)
    expect(await reviewStatus(rev)).toBe('open');
    await settle(db, S_SETTLE);
    expect(await reviewStatus(rev)).toBe('accepted'); // d's "no" no longer ties it
    expect(await resultOf(sun, b)).toBe('failed');
  });
});

describe('fix 6: a late tap that leaves fewer than 2 active participants', () => {
  it('keeps the instance closed (not voided) with no money moved, so the late result can still be challenged', async () => {
    // a wins; b and c both send late "offline" taps, leaving a as the only active participant
    const { sun, u } = await sundayClosed(3, [true, false, false]);
    const [a, b, c] = u;
    expect(await net(db, sun, a)).toBe(1000);
    await checkInAt(db, b, sun, 1, at(S_DEADLINE, 110), at(S_OPEN, 30));
    await checkInAt(db, c, sun, 2, at(S_DEADLINE, 120), at(S_OPEN, 30));
    expect(await resultOf(sun, b)).toBe('unverified');
    expect(await resultOf(sun, c)).toBe('unverified');
    expect(await resultOf(sun, a)).toBe('success');
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [sun])).toBe('closed');
    expect(await net(db, sun, a)).toBe(0);
    expect(await net(db, sun, b)).toBe(0);
    expect(await net(db, sun, c)).toBe(0);
    const rev = await openReview(a, sun, c, 'challenge', at(S_DEADLINE, 130));
    await vote(b, rev, true, at(S_DEADLINE, 131)); // b is the only eligible voter (the opener a does not vote, RT-1)
    expect(await reviewStatus(rev)).toBe('accepted');
    expect(await net(db, sun, a)).toBe(500);
    expect(await net(db, sun, c)).toBe(-500);
    expect(await net(db, sun, b)).toBe(0);
  });
});
