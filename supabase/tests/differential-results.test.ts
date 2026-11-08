import { expect, it } from 'vitest';
import {
  applyReviews,
  checkinVerdict,
  computeResults,
  settlementReviewStatus,
  type CheckinRecord,
  type CheckinVerdict,
  type ReviewKind,
  type ReviewStatus,
} from '../../packages/rules/src/index';
import { createDb, createGroupFixture, rows, scalar, type DB } from './helpers/db';

// Differential test: SQL (check_in_at + declare_freeze_at + tick_instances) vs the TypeScript oracle
// (checkinVerdict + computeResults) on random scenarios. Seed with DIFF_SEED to reproduce.
// A second test does the same for reviews (open_review_at + cast_vote_at + default_open_reviews vs
// settlementReviewStatus + applyReviews).
const SEED = Number(process.env.DIFF_SEED ?? 20261107);
const SCENARIOS = Number(process.env.DIFF_SCENARIOS ?? 320);
const REVIEW_SCENARIOS = Number(process.env.DIFF_REVIEW_SCENARIOS ?? 160);

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = 6371008.8;
function destination(lat: number, lng: number, bearingRad: number, meters: number) {
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const δ = meters / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearingRad));
  const λ2 = λ1 + Math.atan2(Math.sin(bearingRad) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lng: (λ2 * 180) / Math.PI };
}

const iso = (ms: number) => new Date(ms).toISOString();

it(`SQL results match packages/rules computeResults on ${SCENARIOS} random scenarios (seed ${SEED})`, async () => {
  const rnd = mulberry32(SEED);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

  const db: DB = await createDb();
  // Isolate result computation from the payouts migration (tested in its own files).
  await db.exec(`
    create or replace function public.post_instance_payout(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$ begin return; end $$;
    create or replace function public.apply_instance_correction(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$ begin return; end $$;
  `);
  const fx = await createGroupFixture(db, { members: 8, pact: false });

  const mismatches: string[] = [];
  const stats = { success: 0, failed: 0, unverified: 0, frozen: 0, void: 0, voidedInstances: 0, checkins: 0, rejected: 0 };
  const base = Date.parse('2030-01-01T16:00:00.000Z');

  for (let s = 0; s < SCENARIOS; s++) {
    const W = base + s * 86_400_000;
    const D = W + 60 * 60_000;
    const users = [...fx.userIds].sort(() => rnd() - 0.5).slice(0, int(2, 8));

    const pactId = await scalar<string>(
      db,
      `insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by)
       values ($1, $2, '{1,2,3,4,5,6,7}', '08:00', '09:00', 'UTC', $3) returning id`,
      [fx.groupId, `diff ${s}`, fx.ownerId],
    );
    const places = new Map<string, { lat: number; lng: number; radiusM: number }>();
    for (const u of users) {
      const p = { lat: 47.5 + rnd() * 0.3, lng: -122.4 + rnd() * 0.3, radiusM: int(25, 500) };
      places.set(u, p);
      await db.query(
        `insert into public.pact_participants (pact_id, user_id, place_lat, place_lng, place_radius_m, joined_at)
         values ($1, $2, $3, $4, $5, '2020-01-01Z')`,
        [pactId, u, p.lat, p.lng, p.radiusM],
      );
    }
    const inst = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at)
       values ($1, ($2::timestamptz at time zone 'UTC')::date, $2::timestamptz, $3::timestamptz) returning id`,
      [pactId, iso(W), iso(D)],
    );

    const frozen = new Set<string>();
    for (const u of users) {
      if (rnd() < 0.15) {
        await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [u, inst, iso(W - int(1, 3600) * 1000)]);
        frozen.add(u);
      }
    }
    await db.query(`select public.tick_instances($1::timestamptz)`, [iso(W)]);

    type Attempt = {
      user: string; received: number; captured: number; lat: number | null; lng: number | null;
      acc: number | null; sim: boolean; expectAccepted: boolean;
    };
    const attempts: Attempt[] = [];
    for (const u of users) {
      const n = pick([0, 0, 1, 1, 1, 2, 2, 3, 4]);
      for (let k = 0; k < n; k++) {
        const late = rnd() < 0.3;
        let received: number;
        let captured: number;
        if (!late) {
          const r = rnd();
          received = r < 0.05 ? D : r < 0.08 ? W : W + Math.floor(rnd() * (D - W));
          const c = rnd();
          captured = c < 0.7 ? received - int(0, 90_000) : c < 0.9 ? received + int(0, 120_000) : received - int(0, 4 * 3_600_000);
        } else {
          received = D + int(1, 30 * 60_000);
          const c = rnd();
          captured = c < 0.05 ? D : c < 0.08 ? W : c < 0.65 ? W + Math.floor(rnd() * (D - W)) : c < 0.85 ? D + int(1, received - D) : W - int(1, 600_000);
        }
        const place = places.get(u)!;
        const a = rnd();
        const acc = a < 0.08 ? null : a < 0.12 ? -int(1, 50) : a < 0.22 ? 200 + rnd() * 300 : a < 0.26 ? 200 : rnd() * 200;
        const noFix = rnd() < 0.04;
        const dist = place.radiusM * rnd() * 2.5 + (rnd() < 0.2 ? rnd() * 600 : 0);
        const pos = destination(place.lat, place.lng, rnd() * 2 * Math.PI, dist);
        attempts.push({
          user: u, received, captured,
          lat: noFix ? null : pos.lat, lng: noFix ? null : pos.lng,
          acc: noFix && rnd() < 0.5 ? null : acc,
          sim: rnd() < 0.07,
          expectAccepted: !late || (captured >= W && captured <= D),
        });
      }
    }
    attempts.sort((x, y) => x.received - y.received);

    const records: CheckinRecord[] = [];
    for (const t of attempts) {
      let sqlVerdict: string | null = null;
      try {
        const r = await db.query<{ verdict: string }>(
          `select verdict::text from public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, $7, null, $8::timestamptz)`,
          [t.user, inst, t.lat, t.lng, t.acc, iso(t.captured), t.sim, iso(t.received)],
        );
        sqlVerdict = r.rows[0].verdict;
      } catch (e: any) {
        if (t.expectAccepted) mismatches.push(`s${s}: check-in unexpectedly rejected: ${e.message} ${JSON.stringify(t)}`);
        stats.rejected++;
        continue;
      }
      if (!t.expectAccepted) {
        mismatches.push(`s${s}: check-in unexpectedly accepted ${JSON.stringify(t)}`);
        continue;
      }
      stats.checkins++;
      // CONTRACT: a missing fix (no coordinates) is unjudgeable unless simulated; the oracle needs coordinates.
      const oracleVerdict: CheckinVerdict =
        t.lat === null || t.lng === null
          ? t.sim ? 'rejected_simulated' : 'unjudgeable'
          : checkinVerdict({ lat: t.lat, lng: t.lng, accuracyM: t.acc, isSimulated: t.sim }, places.get(t.user)!).verdict;
      if (oracleVerdict !== sqlVerdict) mismatches.push(`s${s}: verdict sql=${sqlVerdict} oracle=${oracleVerdict} ${JSON.stringify(t)}`);
      records.push({ userId: t.user, verdict: oracleVerdict, serverReceivedAt: iso(t.received), clientCapturedAt: iso(t.captured) });
    }

    await db.query(`select public.tick_instances($1::timestamptz)`, [iso(D + 31 * 60_000)]);

    const oracle = computeResults({
      deadlineAt: iso(D),
      participants: users.map((u) => ({ userId: u, frozen: frozen.has(u) })),
      checkins: records,
    });
    const status = await scalar<string>(db, `select status::text from public.pact_instances where id = $1`, [inst]);
    if ((status === 'voided') !== oracle.voided || !['closed', 'voided'].includes(status)) {
      mismatches.push(`s${s}: instance status ${status}, oracle voided=${oracle.voided}`);
    }
    const sql = await rows<{ user_id: string; status: string; first_success_at: Date | null }>(
      db, `select user_id, status::text, first_success_at from public.results where instance_id = $1 order by user_id`, [inst]);
    const sqlMap = new Map(sql.map((r) => [r.user_id, r]));
    if (sql.length !== oracle.results.length) mismatches.push(`s${s}: ${sql.length} SQL results vs ${oracle.results.length} oracle`);
    for (const o of oracle.results) {
      const r = sqlMap.get(o.userId);
      const sqlFirst = r?.first_success_at ? r.first_success_at.getTime() : null;
      const oFirst = o.firstSuccessAt ? Date.parse(o.firstSuccessAt) : null;
      if (!r || r.status !== o.status || sqlFirst !== oFirst) {
        mismatches.push(`s${s} user ${o.userId}: sql=${r?.status}/${sqlFirst} oracle=${o.status}/${oFirst}`);
      }
      (stats as any)[o.status]++;
    }
    if (oracle.voided) stats.voidedInstances++;
  }

  // Coverage of the interesting branches, so a degenerate generator can't pass silently.
  expect(stats.success).toBeGreaterThan(50);
  expect(stats.failed).toBeGreaterThan(50);
  expect(stats.unverified).toBeGreaterThan(50);
  expect(stats.frozen).toBeGreaterThan(20);
  expect(stats.void).toBeGreaterThan(20);
  expect(stats.voidedInstances).toBeGreaterThan(10);
  expect(stats.rejected).toBeGreaterThan(20);
  expect(mismatches.slice(0, 20)).toEqual([]);
}, 600_000);

it(`SQL review resolution and result overrides match packages/rules on ${REVIEW_SCENARIOS} random scenarios (seed ${SEED})`, async () => {
  const rnd = mulberry32(SEED + 1);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const shuffle = <T,>(xs: T[]) => [...xs].sort(() => rnd() - 0.5);

  const db: DB = await createDb();
  await db.exec(`
    create or replace function public.post_instance_payout(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$ begin return; end $$;
    create or replace function public.apply_instance_correction(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$ begin return; end $$;
  `);
  const fx = await createGroupFixture(db, { members: 6, pact: false });

  type Outcome = 'success' | 'failed' | 'unverified';
  type Review = { id: string; subject: string; kind: ReviewKind; openedAt: number; resolvedAt: number; expected: ReviewStatus };
  const mismatches: string[] = [];
  const stats = {
    appeals: 0, challenges: 0, accepted: 0, rejected: 0, defaulted: 0, early: 0, atSettlement: 0,
    appealsDefaulted: 0, chained: 0, voided: 0, lateVotesRefused: 0, excluded: 0,
  };
  const base = Date.parse('2031-01-01T16:00:00.000Z');
  const sqlResult = async (inst: string, u: string) => {
    const r = await rows<{ status: string; first_success_at: Date | null }>(
      db, `select status::text, first_success_at from public.results where instance_id = $1 and user_id = $2`, [inst, u]);
    return { status: r[0].status, first: r[0].first_success_at ? r[0].first_success_at.getTime() : null };
  };

  for (let s = 0; s < REVIEW_SCENARIOS; s++) {
    const W = base + s * 86_400_000;
    const D = W + 60 * 60_000;
    const UNTIL = D + 24 * 60 * 60_000;
    const users = shuffle(fx.userIds).slice(0, int(3, 6));
    const pactId = await scalar<string>(
      db,
      `insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, tz, created_by)
       values ($1, $2, '{1,2,3,4,5,6,7}', '08:00', '09:00', 'UTC', $3) returning id`,
      [fx.groupId, `diff-review ${s}`, fx.ownerId],
    );
    const place = new Map<string, { lat: number; lng: number }>();
    for (const [i, u] of users.entries()) {
      const p = { lat: 47.6 + i * 0.01, lng: -122.3 };
      place.set(u, p);
      await db.query(
        `insert into public.pact_participants (pact_id, user_id, place_lat, place_lng, place_radius_m, joined_at)
         values ($1, $2, $3, $4, 100, '2020-01-01Z')`,
        [pactId, u, p.lat, p.lng],
      );
    }
    const inst = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at)
       values ($1, ($2::timestamptz at time zone 'UTC')::date, $2::timestamptz, $3::timestamptz) returning id`,
      [pactId, iso(W), iso(D)],
    );
    await db.query(`select public.tick_instances($1::timestamptz)`, [iso(W)]);
    for (const u of users) {
      const outcome: Outcome = pick(['success', 'success', 'failed', 'failed', 'unverified']);
      if (outcome === 'failed') continue;
      const p = place.get(u)!;
      const t = iso(W + int(1, 50) * 60_000);
      await db.query(
        `select public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, false, null, $6::timestamptz)`,
        [u, inst, p.lat, p.lng, outcome === 'success' ? 10 : null, t],
      );
    }
    await db.query(`select public.tick_instances($1::timestamptz)`, [iso(D + 60_000)]);
    if ((await scalar<string>(db, `select status::text from public.pact_instances where id = $1`, [inst])) !== 'closed') {
      stats.voided++;
      continue;
    }
    const baseResults = new Map<string, { status: string; first: number | null }>();
    for (const u of users) baseResults.set(u, await sqlResult(inst, u));

    const reviews: Review[] = [];
    let t = D + 60 * 60_000; // strictly increasing instants, well before UNTIL
    const bump = () => (t += 60_000);
    const phase = async (kind: ReviewKind) => {
      for (const u of users) {
        const cur = (await sqlResult(inst, u)).status;
        if (kind === 'appeal' ? cur !== 'failed' : !['success', 'unverified'].includes(cur)) continue;
        if (rnd() > 0.7) continue;
        const opener = kind === 'appeal' ? u : pick(users.filter((x) => x !== u));
        const openedAt = bump();
        const id = await scalar<string>(
          db,
          `select public.open_review_at($1, $2, $3, $4::public.review_kind, 'r', null, $5::timestamptz)`,
          [opener, inst, u, kind, iso(openedAt)],
        );
        if (kind === 'appeal') stats.appeals++;
        else stats.challenges++;
        if (kind === 'challenge' && reviews.some((r) => r.subject === u)) stats.chained++;
        const eligible = users.filter((x) => x !== u);
        let yes = 0;
        let no = 0;
        let early: { status: ReviewStatus; at: number } | null = null;
        for (const voter of shuffle(eligible)) {
          if (rnd() > 0.55) continue;
          const supports = rnd() < 0.5;
          const at = bump();
          if (early) {
            // the review is resolved: SQL must refuse the vote
            try {
              await db.query(`select public.cast_vote_at($1, $2, $3, $4::timestamptz)`, [voter, id, supports, iso(at)]);
              mismatches.push(`s${s}: vote accepted on a resolved ${kind}`);
            } catch (e: any) {
              if (e.code !== '23514') mismatches.push(`s${s}: late vote refused with ${e.code}, expected 23514`);
              stats.lateVotesRefused++;
            }
            continue;
          }
          await db.query(`select public.cast_vote_at($1, $2, $3, $4::timestamptz)`, [voter, id, supports, iso(at)]);
          if (supports) yes++;
          else no++;
          // a majority of ELIGIBLE voters resolves immediately (cast_vote_at)
          if (2 * yes > eligible.length) early = { status: 'accepted', at };
          else if (2 * no > eligible.length) early = { status: 'rejected', at };
        }
        const expected: ReviewStatus = early ? early.status : settlementReviewStatus(yes, no);
        if (early) stats.early++;
        else stats.atSettlement++;
        stats[expected as 'accepted' | 'rejected' | 'defaulted']++;
        if (kind === 'appeal' && expected === 'defaulted') stats.appealsDefaulted++;
        reviews.push({ id, subject: u, kind, openedAt, resolvedAt: early ? early.at : UNTIL, expected });
      }
    };
    await phase('appeal');
    await phase('challenge');
    await db.query(`select public.default_open_reviews($1, $2::timestamptz)`, [fx.groupId, iso(UNTIL)]);

    for (const r of reviews) {
      const got = await rows<{ status: string; resolved_at: Date }>(db, `select status::text, resolved_at from public.reviews where id = $1`, [r.id]);
      if (got[0].status !== r.expected) mismatches.push(`s${s}: ${r.kind} on ${r.subject} sql=${got[0].status} oracle=${r.expected}`);
      if (got[0].resolved_at.getTime() !== r.resolvedAt) {
        mismatches.push(`s${s}: ${r.kind} resolved_at sql=${got[0].resolved_at.toISOString()} oracle=${iso(r.resolvedAt)}`);
      }
    }
    for (const u of users) {
      const b = baseResults.get(u)!;
      const mine = reviews
        .filter((r) => r.subject === u)
        .sort((x, y) => x.resolvedAt - y.resolvedAt || x.openedAt - y.openedAt)
        .map((r) => ({ kind: r.kind, status: r.expected }));
      const oracle = applyReviews(
        { userId: u, status: b.status as 'success' | 'failed' | 'unverified', firstSuccessAt: b.first === null ? null : iso(b.first) },
        iso(D),
        mine,
      );
      const sql = await sqlResult(inst, u);
      const oFirst = oracle.firstSuccessAt === null ? null : Date.parse(oracle.firstSuccessAt);
      if (sql.status !== oracle.status || sql.first !== oFirst) {
        mismatches.push(`s${s} user ${u}: base=${b.status} reviews=${JSON.stringify(mine)} sql=${sql.status}/${sql.first} oracle=${oracle.status}/${oFirst}`);
      }
      if (sql.status === 'excluded') stats.excluded++;
    }
  }

  // Coverage: every branch of the review rules must have been exercised.
  expect(stats.appeals).toBeGreaterThan(40);
  expect(stats.challenges).toBeGreaterThan(40);
  expect(stats.accepted).toBeGreaterThan(15);
  expect(stats.rejected).toBeGreaterThan(15);
  expect(stats.defaulted).toBeGreaterThan(15);
  expect(stats.early).toBeGreaterThan(10);
  expect(stats.atSettlement).toBeGreaterThan(10);
  expect(stats.appealsDefaulted).toBeGreaterThan(8); // the N3-1 branch: the miss must stand
  expect(stats.chained).toBeGreaterThan(0); // accepted appeal, then its new success challenged
  expect(stats.lateVotesRefused).toBeGreaterThan(3);
  expect(stats.excluded).toBe(0);
  expect(mismatches.slice(0, 20)).toEqual([]);
}, 600_000);
