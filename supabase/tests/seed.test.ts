// supabase/seed.sql must apply against the full migration chain (it runs after every migration on
// `supabase db reset`), be idempotent, and leave the ledger empty. PGlite's auth.users is the
// (id, email) stub, so this exercises the seed's non-GoTrue branch; the GoTrue branch is the same
// DO block with a different INSERT and is covered by `supabase db reset` on a local stack.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, rows, scalar, type DB } from './helpers/db';

const SEED_SQL = readFileSync(new URL('../seed.sql', import.meta.url), 'utf8');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const PACT = '44444444-4444-4444-8444-444444444444';

describe('seed.sql', () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
    // The CLI applies the seed over the same connection as the migrations (role postgres), so it
    // runs as postgres here too; asService below is how the rest of the system reads the result.
    await db.exec(SEED_SQL);
  });

  it('creates the two users with profiles', async () => {
    const users = await rows<{ id: string; email: string }>(db, `select id::text, email from auth.users order by email`);
    expect(users).toEqual([
      { id: ALICE, email: 'alice@example.com' },
      { id: BOB, email: 'bob@example.com' },
    ]);
    const names = await asService(db, (d) =>
      rows<{ id: string; display_name: string }>(d, `select id::text, display_name from public.profiles order by display_name`),
    );
    expect(names).toEqual([
      { id: ALICE, display_name: 'Alice' },
      { id: BOB, display_name: 'Bob' },
    ]);
  });

  it('creates the group with both members and the pact with two places in force', async () => {
    await asService(db, async (d) => {
      expect(await rows(d, `select name, invite_code, settlement_tz from public.groups where id = $1`, [GROUP])).toEqual([
        { name: 'Kane Hall crew', invite_code: 'SEEDKANE01', settlement_tz: 'America/Los_Angeles' },
      ]);
      expect(
        await rows(d, `select user_id::text, role from public.group_members where group_id = $1 and left_at is null order by role`, [GROUP]),
      ).toEqual([
        { user_id: BOB, role: 'member' },
        { user_id: ALICE, role: 'owner' },
      ]);
      expect(
        await rows(d, `select title, stake_cents, tz, paused from public.pacts where id = $1 and group_id = $2`, [PACT, GROUP]),
      ).toEqual([{ title: '9am class', stake_cents: 500, tz: 'America/Los_Angeles', paused: false }]);
      expect(
        await rows(
          d,
          `select user_id::text, place_label, place_radius_m from public.pact_participants where pact_id = $1 and left_at is null order by place_label`,
          [PACT],
        ),
      ).toEqual([
        { user_id: ALICE, place_label: 'Kane Hall', place_radius_m: 100 },
        { user_id: BOB, place_label: 'Odegaard Library', place_radius_m: 100 },
      ]);
      // first places count at once (N1-1): a history row each, not gated, in force now
      expect(
        await rows(
          d,
          `select user_id::text, requires_ack, (effective_from <= now()) as in_force
             from public.pact_participant_places where pact_id = $1 order by user_id`,
          [PACT],
        ),
      ).toEqual([
        { user_id: ALICE, requires_ack: false, in_force: true },
        { user_id: BOB, requires_ack: false, in_force: true },
      ]);
      expect(await scalar<number>(d, `select count(*)::int from public.place_events where pact_id = $1 and kind = 'created'`, [PACT])).toBe(2);
    });
  });

  it('generated the coming week of instances for the pact', async () => {
    const n = await asService(db, (d) =>
      scalar<number>(d, `select count(*)::int from public.pact_instances where pact_id = $1 and status = 'scheduled'`, [PACT]),
    );
    // Mon-Fri within the next 8 local days: 5 or 6 weekdays depending on today, always at least 5.
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(6);
  });

  it('leaves the ledger empty', async () => {
    await asService(db, async (d) => {
      expect(await scalar<number>(d, `select count(*)::int from public.ledger_entries`)).toBe(0);
      expect(await scalar<number>(d, `select count(*)::int from public.ledger_lines`)).toBe(0);
      expect(await scalar<number>(d, `select count(*)::int from public.results`)).toBe(0);
      expect(await scalar<number>(d, `select count(*)::int from public.checkins`)).toBe(0);
    });
  });

  it('is idempotent: applying it again changes nothing', async () => {
    const before = await snapshot(db);
    await db.exec(SEED_SQL);
    expect(await snapshot(db)).toEqual(before);
  });

  it('seeded users see their group through RLS as the app would', async () => {
    const seen = await asUser(db, BOB, (d) => rows<{ name: string }>(d, `select name from public.groups`));
    expect(seen).toEqual([{ name: 'Kane Hall crew' }]);
    const members = await asUser(db, ALICE, (d) =>
      rows<{ display_name: string }>(d, `select display_name from public.profiles order by display_name`),
    );
    expect(members.map((m) => m.display_name)).toEqual(['Alice', 'Bob']);
  });
});

async function snapshot(db: DB) {
  // auth.users is read as postgres: the stub grants the service role nothing in schema auth.
  const users = await scalar<number>(db, `select count(*)::int from auth.users`);
  return asService(db, async (d) => ({
    users,
    profiles: await rows(d, `select id::text, display_name from public.profiles order by id`),
    members: await rows(d, `select group_id::text, user_id::text, role from public.group_members order by user_id`),
    participants: await rows(d, `select pact_id::text, user_id::text, place_label from public.pact_participants order by user_id`),
    places: await rows(d, `select id::text, user_id::text, label from public.pact_participant_places order by id`),
    events: await rows(d, `select id, kind, user_id::text from public.place_events order by id`),
    instances: await rows(d, `select id::text, local_date::text, status::text from public.pact_instances order by local_date`),
    outbox: await scalar<number>(d, `select count(*)::int from public.notification_outbox`),
    ledger: await scalar<number>(d, `select count(*)::int from public.ledger_lines`),
  }));
}
