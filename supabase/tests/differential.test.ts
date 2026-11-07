import { describe, expect, it } from 'vitest';
import { computeInstancePayout, simplifyDebts, type ParticipantResult } from '../../packages/rules/src/index';
import { asService, asUser, createDb, createGroupFixture, rows, scalar, type DB } from './helpers/db';

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
      // settlement_payment entries (no instance) are billable at once, like confirmed settle-ups
      await db.query(`select public.post_entry($1, 'settlement_payment', $2, null, 'differential', $3::jsonb)`, [
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

describe('property: random post / correct / settle / settle-up sequences', () => {
  it('keep the ledger balanced and carries >= 0; re-running settlement and corrections is a no-op (210 scenarios)', async () => {
    const rnd = mulberry32(SEED ^ 0x0b11ca7e);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const SCENARIOS = 210;
    const PER_DB = 15;
    const START = Date.UTC(2026, 8, 7); // Mon 2026-09-07
    const statuses: Status[] = ['success', 'success', 'failed', 'failed', 'failed', 'unverified', 'excluded', 'frozen'];
    const stats = { instances: 0, corrections: 0, settledCorrections: 0, settles: 0, marks: 0, confirms: 0, disputes: 0, claws: 0 };
    let db!: DB;

    const post = (id: string) => asService(db, (d) => d.query(`select public.post_instance_payout($1)`, [id]));
    const correct = (id: string) => asService(db, (d) => d.query(`select public.apply_instance_correction($1)`, [id]));
    const settle = (now: string) => asService(db, (d) => scalar<number>(d, `select public.settle_due_groups($1::timestamptz)`, [now]));
    const setResult = (id: string, uid: string, st: Status, fsa: string | null) =>
      db.query(
        `insert into public.results (instance_id, user_id, status, first_success_at) values ($1, $2, $3, $4)
         on conflict (instance_id, user_id) do update set status = excluded.status, first_success_at = excluded.first_success_at`,
        [id, uid, st, fsa],
      );

    for (let s = 0; s < SCENARIOS; s++) {
      if (s % PER_DB === 0) db = await createDb();
      const fx = await createGroupFixture(db, { members: int(2, 4), pact: { stakeCents: pick([1, 3, 100, 500, 777, 10000]) } });
      await db.query(`update public.groups set created_at = '2026-09-07T07:00:00Z' where id = $1`, [fx.groupId]);
      const pact = fx.pactId!;
      const users = fx.userIds;
      const insts: { id: string; date: string }[] = [];
      let day = 0;
      let now = '2026-09-07T07:00:00Z';
      const randomFsa = (date: string, st: Status) =>
        st === 'success' && rnd() < 0.95 ? `${date}T15:${String(pick([0, 0, 5, 30, 59])).padStart(2, '0')}:00Z` : null;

      const snapshot = async () => ({
        lines: await scalar<number>(db, `select count(*)::int from public.ledger_lines`),
        obligations: await rows(
          db,
          `select id, from_user, to_user, amount_cents::bigint a, status::text from public.obligations where group_id = $1 order by id`,
          [fx.groupId],
        ),
        carryIns: await rows(db, `select id, carry_in_cents::bigint c, status::text from public.pact_instances where pact_id = $1 order by id`, [pact]),
        settlements: await scalar<number>(db, `select count(*)::int from public.settlements where group_id = $1`, [fx.groupId]),
      });
      const invariants = async (ctx: string) => {
        const [r] = await rows<{ total: string; min_carry: string; pots: number; min_ci: string; billable: string }>(
          db,
          `select (select coalesce(sum(amount_cents), 0) from public.ledger_lines)::bigint total,
                  (select coalesce(min(balance_cents), 0) from public.account_balances where kind = 'carry' and group_id = $1)::bigint min_carry,
                  (select count(*) from public.account_balances where kind = 'pot' and group_id = $1 and balance_cents <> 0)::int pots,
                  (select coalesce(min(carry_in_cents), 0) from public.pact_instances where pact_id = $2)::bigint min_ci,
                  (select coalesce(sum(balance_cents), 0) from public.billable_member_balances where group_id = $1)::bigint billable`,
          [fx.groupId, pact],
        );
        expect(Number(r.total), ctx).toBe(0);
        expect(Number(r.min_carry), ctx).toBeGreaterThanOrEqual(0);
        expect(r.pots, ctx).toBe(0);
        expect(Number(r.min_ci), ctx).toBeGreaterThanOrEqual(0);
        expect(Number(r.billable), ctx).toBeLessThanOrEqual(0);
      };
      const rerunIsNoop = async (ctx: string) => {
        const before = await snapshot();
        expect(await settle(now), ctx).toBe(0);
        for (const i of before.carryIns as { id: string; c: string | null }[]) if (i.c !== null) await correct(i.id);
        expect(await snapshot(), ctx).toEqual(before);
      };

      const steps = int(12, 30);
      const log: string[] = [];
      try {
        for (let k = 0; k < steps; k++) {
          const ctx = JSON.stringify({ seed: SEED, scenario: s, step: k });
          const r = rnd();
          if (r < 0.4 || insts.length === 0) {
            const date = new Date(START + day * 86_400_000).toISOString().slice(0, 10);
            day += int(1, 2);
            const id = await scalar<string>(
              db,
              `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status, closed_at)
               select $1, $2::date, t - interval '1 hour', t, 'closed', t
                 from (select ($2::date + time '09:00') at time zone 'America/Los_Angeles' t) x returning id`,
              [pact, date],
            );
            for (const uid of users) {
              if (rnd() < 0.15) continue;
              const st = pick(statuses);
              await setResult(id, uid, st, randomFsa(date, st));
            }
            insts.push({ id, date });
            stats.instances++;
            now = `${date}T18:00:00Z`;
            const posted = rnd() < 0.75;
            log.push(`new ${insts.length - 1} ${date}${posted ? ' posted' : ''}`);
            if (posted) await post(id);
          } else if (r < 0.65) {
            const inst = pick(insts);
            const changes = int(1, 2);
            const what: string[] = [];
            for (let c = 0; c < changes; c++) {
              const st = pick(statuses);
              const who = pick(users);
              const fsa = randomFsa(inst.date, st);
              await setResult(inst.id, who, st, fsa);
              what.push(`${who.slice(0, 4)}=${st}${fsa ? '@' + fsa.slice(11, 16) : ''}`);
            }
            log.push(`correct ${insts.indexOf(inst)} ${what.join(',')}`);
            const clawsBefore = await scalar<number>(
              db,
              `select count(*)::int from public.ledger_entries e where e.kind = 'correction' and e.instance_id <> $1
                  and e.instance_id in (select id from public.pact_instances where pact_id = $2)`,
              [inst.id, pact],
            );
            if ((await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst.id])) === 'settled')
              stats.settledCorrections++;
            await correct(inst.id);
            stats.corrections++;
            const clawsAfter = await scalar<number>(
              db,
              `select count(*)::int from public.ledger_entries e where e.kind = 'correction' and e.instance_id <> $1
                  and e.instance_id in (select id from public.pact_instances where pact_id = $2)`,
              [inst.id, pact],
            );
            if (clawsAfter > clawsBefore) stats.claws++;
          } else if (r < 0.77) {
            now = new Date(START + day * 86_400_000 + 20 * 3_600_000).toISOString();
            log.push(`settle ${now}`);
            await settle(now);
            stats.settles++;
            await invariants(ctx);
            await rerunIsNoop(ctx);
          } else {
            const obs = await rows<{ id: string; from_user: string; to_user: string; status: string }>(
              db,
              `select id, from_user::text, to_user::text, status::text from public.obligations
                where group_id = $1 and status in ('pending', 'marked_paid') order by id`,
              [fx.groupId],
            );
            if (obs.length === 0) continue;
            const o = pick(obs);
            const a = rnd();
            log.push(`settle-up ${o.status} ${o.from_user.slice(0, 4)}>${o.to_user.slice(0, 4)} a=${a.toFixed(2)}`);
            if (o.status === 'pending' && a < 0.6) {
              await asUser(db, o.from_user, (d) => d.query(`select public.mark_obligation_paid($1)`, [o.id]));
              stats.marks++;
            } else if (o.status === 'marked_paid' && a < 0.5) {
              await asUser(db, o.to_user, (d) => d.query(`select public.dispute_obligation($1)`, [o.id]));
              stats.disputes++;
            } else {
              await asUser(db, o.to_user, (d) => d.query(`select public.confirm_obligation($1)`, [o.id]));
              stats.confirms++;
            }
          }
          await invariants(ctx);
        }
        // settle whatever is due, then everything must be stable
        const end = JSON.stringify({ seed: SEED, scenario: s, step: 'end' });
        await settle(now);
        await invariants(end);
        await rerunIsNoop(end);
      } catch (e: any) {
        e.message += ` ops: ${JSON.stringify(log)}`; // the failing op is the last one
        throw e;
      }
    }
    // the random walk must actually reach the interesting paths
    expect(stats.settledCorrections, JSON.stringify(stats)).toBeGreaterThan(100);
    expect(stats.claws, JSON.stringify(stats)).toBeGreaterThan(20);
    expect(stats.settles, JSON.stringify(stats)).toBeGreaterThan(200);
    expect(stats.confirms, JSON.stringify(stats)).toBeGreaterThan(30);
    expect(stats.marks, JSON.stringify(stats)).toBeGreaterThan(30);
    expect(stats.disputes, JSON.stringify(stats)).toBeGreaterThan(3);
  }, 900_000);
});
