import { expect, it } from 'vitest';
import { checkinVerdict, computeResults, type CheckinRecord, type CheckinVerdict } from '../../packages/rules/src/index';
import { createDb, createGroupFixture, rows, scalar, type DB } from './helpers/db';

// Differential test: SQL (check_in_at + declare_freeze_at + tick_instances) vs the TypeScript oracle
// (checkinVerdict + computeResults) on random scenarios. Seed with DIFF_SEED to reproduce.
const SEED = Number(process.env.DIFF_SEED ?? 20261107);
const SCENARIOS = Number(process.env.DIFF_SCENARIOS ?? 320);

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
