import { describe, expect, it } from 'vitest';
import { computeInstancePayout, simplifyDebts, type ParticipantResult } from '../../packages/rules/src/index';
import { asService, createDb, createGroupFixture, rows, scalar, type DB } from './helpers/db';

// Differential tests: the SQL money layer must agree exactly with the TypeScript oracle in packages/rules.
// Seeded PRNG so failures are reproducible; override with DIFF_SEED=<n>.
const SEED = Number(process.env.DIFF_SEED ?? 20261107);

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Status = ParticipantResult['status'];

describe('differential: SQL payouts vs computeInstancePayout', () => {
  it('matches on 500+ random instances (with random pre-existing carry) and on random corrections', async () => {
    const rnd = mulberry32(SEED);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const shuffle = <T>(xs: T[]) => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    const db = await createDb();
    const fx = await createGroupFixture(db, { members: 8, pact: false });
    const users = fx.userIds;
    let day = 0;

    const statuses: Status[] = ['success', 'success', 'success', 'failed', 'failed', 'failed', 'unverified', 'frozen', 'excluded'];
    const times = ['15:00:00', '15:00:00', '15:01:30', '15:07:00', '15:20:00', '15:59:59'];
    const randomFsa = (status: Status) => {
      if (status !== 'success') return null;
      if (rnd() < 0.05) return null; // oracle sorts null last (Infinity); SQL uses nulls last
      return `2026-01-01T${pick(times)}Z`;
    };

    async function newPact(stake: number): Promise<string> {
      return scalar<string>(
        db,
        `insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, stake_cents, tz, created_by)
         values ($1, 'diff', '{1,2,3,4,5,6,7}', '08:00', '09:00', $2, 'America/Los_Angeles', $3) returning id`,
        [fx.groupId, stake, fx.ownerId],
      );
    }

    async function instance(pact: string, results: ParticipantResult[]): Promise<string> {
      const localDate = new Date(Date.UTC(2020, 0, 1) + day++ * 86_400_000).toISOString().slice(0, 10);
      const id = await scalar<string>(
        db,
        `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status, closed_at)
         values ($1, $2, $2::date + time '16:00', $2::date + time '17:00', 'closed', $2::date + time '17:00') returning id`,
        [pact, localDate],
      );
      await setResults(id, results);
      return id;
    }

    async function setResults(id: string, results: ParticipantResult[]) {
      await db.query(
        `insert into public.results (instance_id, user_id, status, first_success_at)
         select $1, r.user_id, r.status::public.result_status, r.fsa
           from jsonb_to_recordset($2::jsonb) r(user_id uuid, status text, fsa timestamptz)
         on conflict (instance_id, user_id) do update set status = excluded.status, first_success_at = excluded.first_success_at`,
        [id, JSON.stringify(results.map((r) => ({ user_id: r.userId, status: r.status, fsa: r.firstSuccessAt })))],
      );
    }

    const post = (id: string) => asService(db, (d) => d.query(`select public.post_instance_payout($1)`, [id]));
    const correct = (id: string) => asService(db, (d) => d.query(`select public.apply_instance_correction($1)`, [id]));
    const carryBalance = async (pact: string) =>
      Number(
        await scalar(
          db,
          `select coalesce(sum(balance_cents), 0)::bigint from public.account_balances where kind = 'carry' and pact_id = $1`,
          [pact],
        ),
      );

    async function effect(id: string) {
      const r = await rows<{ kind: string; user_id: string | null; amt: number }>(
        db,
        `select a.kind::text, a.user_id::text, sum(l.amount_cents)::bigint amt
           from public.ledger_entries e
           join public.ledger_lines l on l.entry_id = e.id
           join public.ledger_accounts a on a.id = l.account_id
          where e.instance_id = $1
          group by 1, 2 having sum(l.amount_cents) <> 0`,
        [id],
      );
      const memberDeltas: Record<string, number> = {};
      let carryDelta = 0;
      let pot = 0;
      for (const x of r) {
        if (x.kind === 'member') memberDeltas[x.user_id!] = Number(x.amt);
        else if (x.kind === 'carry') carryDelta = Number(x.amt);
        else pot += Number(x.amt);
      }
      return { memberDeltas, carryDelta, pot };
    }

    function randomResults(): ParticipantResult[] {
      const m = int(2, 8);
      return shuffle(users)
        .slice(0, m)
        .map((userId) => {
          const status = pick(statuses);
          return { userId, status, firstSuccessAt: randomFsa(status) };
        });
    }

    const N = 520;
    let withCarry = 0;
    let corrected = 0;
    let leftoverCases = 0;
    for (let c = 0; c < N; c++) {
      const stake = rnd() < 0.15 ? pick([1, 2, 3, 7, 9999, 10000]) : int(1, 10000);
      const pact = await newPact(stake);
      // random pre-existing carry: post 0..3 all-fail instances first
      const seeds = rnd() < 0.6 ? int(1, 3) : 0;
      for (let s = 0; s < seeds; s++) {
        const losers = shuffle(users).slice(0, int(2, 8));
        const id = await instance(
          pact,
          losers.map((userId) => ({ userId, status: 'failed', firstSuccessAt: null })),
        );
        await post(id);
      }
      const carryBefore = await carryBalance(pact);
      if (carryBefore > 0) withCarry++;

      const results = randomResults();
      const id = await instance(pact, results);
      await post(id);
      const carryIn = Number(await scalar(db, `select carry_in_cents from public.pact_instances where id = $1`, [id]));
      const ctx = JSON.stringify({ seed: SEED, case: c, stake, carryBefore, results });
      expect(carryIn, ctx).toBe(carryBefore);

      const expected = computeInstancePayout({ stakeCents: stake, carryInCents: carryIn, results });
      const got = await effect(id);
      expect(got.pot, ctx).toBe(0);
      expect(got.memberDeltas, ctx).toEqual(expected.memberDeltas);
      expect(got.carryDelta, ctx).toBe(expected.carryDelta);
      expect(await carryBalance(pact), ctx).toBe(carryBefore + expected.carryDelta);
      const winners = results.filter((r) => r.status === 'success').length;
      if (winners > 0 && (stake * results.filter((r) => r.status === 'failed').length + carryIn) % winners !== 0) leftoverCases++;

      // idempotent re-post
      await post(id);
      expect((await effect(id)).memberDeltas, ctx).toEqual(expected.memberDeltas);

      // random correction(s) on the latest instance of the pact: target is the oracle on the new results
      if (rnd() < 0.4) {
        corrected++;
        const rounds = int(1, 2);
        let current = results;
        for (let k = 0; k < rounds; k++) {
          current = current.map((r) => {
            if (rnd() < 0.4) {
              const status = pick(statuses);
              return { userId: r.userId, status, firstSuccessAt: randomFsa(status) };
            }
            return r;
          });
          await setResults(id, current);
          await correct(id);
          const exp2 = computeInstancePayout({ stakeCents: stake, carryInCents: carryIn, results: current });
          const got2 = await effect(id);
          const ctx2 = JSON.stringify({ seed: SEED, case: c, round: k, stake, carryIn, current });
          expect(got2.pot, ctx2).toBe(0);
          expect(got2.memberDeltas, ctx2).toEqual(exp2.memberDeltas);
          expect(got2.carryDelta, ctx2).toBe(exp2.carryDelta);
          expect(await carryBalance(pact), ctx2).toBe(carryBefore + exp2.carryDelta);
        }
      }
    }
    // Make sure the random cases actually exercised the interesting paths.
    expect(withCarry).toBeGreaterThan(100);
    expect(corrected).toBeGreaterThan(100);
    expect(leftoverCases).toBeGreaterThan(50);
    // Global conservation: members + carries sum to zero, pots are empty.
    expect(Number(await scalar(db, `select coalesce(sum(amount_cents), 0)::bigint from public.ledger_lines`))).toBe(0);
    expect(
      Number(await scalar(db, `select count(*)::int from public.account_balances where kind = 'pot' and balance_cents <> 0`)),
    ).toBe(0);
    expect(
      Number(await scalar(db, `select count(*)::int from public.account_balances where kind = 'carry' and balance_cents < 0`)),
    ).toBe(0);
  }, 600_000);
});

describe('differential: settlement obligations vs simplifyDebts', () => {
  it('matches on random balances over many consecutive weeks', async () => {
    const rnd = mulberry32(SEED ^ 0x5eed);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const db = await createDb();
    const fx = await createGroupFixture(db, { members: 8 });
    const users = fx.userIds;
    // created Wed 2026-01-07 (LA); week of 2026-01-05 settles Mon 2026-01-12 12:00 PST = 20:00Z
    await db.query(`update public.groups set created_at = '2026-01-07T20:00:00Z' where id = $1`, [fx.groupId]);
    const memberAcct: Record<string, string> = {};
    for (const uid of users) {
      memberAcct[uid] = await scalar<string>(db, `select public.ensure_account($1, 'member', $2, null, null)`, [fx.groupId, uid]);
    }
    const carryAcct = await scalar<string>(db, `select public.ensure_account($1, 'carry', null, null, $2)`, [
      fx.groupId,
      fx.pactId,
    ]);

    const ROUNDS = 120;
    let week = Date.parse('2026-01-12T12:00:00-08:00');
    let checked = 0;
    for (let r = 0; r < ROUNDS; r++) {
      // random target balances, with ties and zeros; total <= 0 (the rest rides in the carry)
      const target: Record<string, number> = {};
      const style = r % 3;
      for (const uid of users) {
        target[uid] =
          style === 0 ? int(-5000, 5000) : style === 1 ? int(-4, 4) * 250 : rnd() < 0.3 ? 0 : int(-30000, 30000);
      }
      const total = Object.values(target).reduce((a, b) => a + b, 0);
      if (total > 0) target[users[int(0, users.length - 1)]] -= total + (rnd() < 0.5 ? 0 : int(0, 3000));

      const current: Record<string, number> = Object.fromEntries(
        (
          await rows<{ user_id: string; b: number }>(
            db,
            `select user_id::text, balance_cents::bigint b from public.member_balances where group_id = $1`,
            [fx.groupId],
          )
        ).map((x) => [x.user_id, Number(x.b)]),
      );
      const lines = users.map((uid) => ({ account_id: memberAcct[uid], amount_cents: target[uid] - (current[uid] ?? 0) }));
      const sum = lines.reduce((a, l) => a + l.amount_cents, 0);
      lines.push({ account_id: carryAcct, amount_cents: -sum });
      await db.query(`select public.post_entry($1, 'correction', $2, null, 'differential', $3::jsonb)`, [
        fx.groupId,
        `diff-adjust:${r}`,
        JSON.stringify(lines),
      ]);

      // settle exactly at Monday noon local (DST-aware: compute in SQL)
      const due = await scalar<Date>(
        db,
        `select ((date_trunc('week', ($1::timestamptz at time zone 'America/Los_Angeles'))::date) + time '12:00') at time zone 'America/Los_Angeles'`,
        [new Date(week).toISOString()],
      );
      expect(await asService(db, (d) => scalar<number>(d, `select public.settle_due_groups($1)`, [due]))).toBe(1);
      week += 7 * 86_400_000;

      const got = (
        await rows<{ f: string; t: string; a: number }>(
          db,
          `select o.from_user::text f, o.to_user::text t, o.amount_cents::bigint a
             from public.obligations o
             join public.settlements s on s.id = o.settlement_id
            where o.group_id = $1 and o.status = 'pending'`,
          [fx.groupId],
        )
      ).map((o) => `${o.f}|${o.t}|${Number(o.a)}`);
      const expected = simplifyDebts(target).obligations.map((o) => `${o.from}|${o.to}|${o.amountCents}`);
      expect(got.sort(), JSON.stringify({ seed: SEED, round: r, target })).toEqual(expected.sort());
      checked++;
    }
    expect(checked).toBe(ROUNDS);
    expect(Number(await scalar(db, `select count(*)::int from public.settlements where group_id = $1`, [fx.groupId]))).toBe(ROUNDS);
  }, 600_000);
});
