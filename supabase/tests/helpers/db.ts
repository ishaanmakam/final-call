import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = PGlite;

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../../migrations');

/**
 * Supabase-like environment installed BEFORE migrations.
 * Mirrors what a fresh Supabase project gives the `postgres` role:
 *  - roles anon / authenticated / service_role (service_role bypasses RLS)
 *  - schema auth with auth.users(id, email) and auth.uid() / auth.role() / auth.jwt()
 *  - Supabase's default privileges on schema public (ALL to anon, authenticated, service_role),
 *    so migrations are tested against the same permissive defaults they face in production.
 */
export const SUPABASE_STUB_SQL = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export function migrationFiles(filter?: (name: string) => boolean): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => (filter ? filter(f) : true))
    .sort();
}

export interface CreateDbOptions {
  /** Restrict which migration files are applied (default: all, sorted by name). */
  filter?: (filename: string) => boolean;
  /** Reuse a per-process template (default true). Set false to force a cold build. */
  cache?: boolean;
}

const templates = new Map<string, Promise<Blob | File>>();

async function buildFresh(filter?: (name: string) => boolean): Promise<DB> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(SUPABASE_STUB_SQL);
  for (const file of migrationFiles(filter)) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (e: any) {
      throw new Error(`migration ${file} failed: ${e?.message ?? e}`);
    }
  }
  return db;
}

/**
 * Fresh, fully migrated database. The first call per process builds a template
 * (stub + all migrations) and dumps its data dir; later calls clone it (~0.5s).
 */
export async function createDb(opts: CreateDbOptions = {}): Promise<DB> {
  if (opts.cache === false) return buildFresh(opts.filter);
  const key = migrationFiles(opts.filter).join('|');
  let tpl = templates.get(key);
  if (!tpl) {
    tpl = (async () => {
      const db = await buildFresh(opts.filter);
      const dump = await db.dumpDataDir('none');
      await db.close();
      return dump;
    })();
    templates.set(key, tpl);
    tpl.catch(() => templates.delete(key));
  }
  const db = new PGlite({ loadDataDir: await tpl });
  await db.waitReady;
  return db;
}

async function resetSession(db: DB) {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false);`,
  );
}

/** Run fn as Postgres role `authenticated` with auth.uid() = userId. Session is reset afterwards (even on error). */
export async function asUser<T>(db: DB, userId: string, fn: (db: DB) => Promise<T>): Promise<T> {
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`,
    [userId],
  );
  await db.exec(`set role authenticated`);
  try {
    return await fn(db);
  } finally {
    await resetSession(db);
  }
}

/** Run fn as role `anon` (no auth.uid()). */
export async function asAnon<T>(db: DB, fn: (db: DB) => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.role', 'anon', false); set role anon`);
  try {
    return await fn(db);
  } finally {
    await resetSession(db);
  }
}

/** Run fn as role `service_role` (bypasses RLS, like the Supabase service key / pg_cron jobs). */
export async function asService<T>(db: DB, fn: (db: DB) => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false); set role service_role`);
  try {
    return await fn(db);
  } finally {
    await resetSession(db);
  }
}

let userSeq = 0;
/** Insert into auth.users (profile row is created by trigger). Returns the user id. */
export async function createUser(db: DB, email?: string, displayName?: string): Promise<string> {
  const e = email ?? `user${++userSeq}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const r = await db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [e]);
  const id = r.rows[0].id;
  if (displayName) await db.query(`update public.profiles set display_name = $2 where id = $1`, [id, displayName]);
  return id;
}

/** Shorthand: run a single statement and return rows. */
export async function rows<T = any>(db: DB, sql: string, params: any[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** Shorthand: first column of the first row. */
export async function scalar<T = any>(db: DB, sql: string, params: any[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params);
  const row = r.rows[0];
  return row === undefined ? (undefined as T) : (Object.values(row)[0] as T);
}

export interface PactSpec {
  title?: string;
  days?: number[];
  windowOpen?: string | null;
  deadline?: string;
  stakeCents?: number;
  tz?: string;
}

export interface GroupFixture {
  groupId: string;
  inviteCode: string;
  ownerId: string;
  /** All current members, owner first. */
  userIds: string[];
  pactId: string | null;
  /** Users who joined the pact (default: all members). */
  participantIds: string[];
}

/**
 * Build a group with `members` users (first is owner) via the real RPCs, optionally a pact
 * created by the owner that `participants` (default: all members) join with a place
 * (lat 47.6553 + i*0.01, lng -122.3035, radius 100m, label "place <i>").
 */
export async function createGroupFixture(
  db: DB,
  opts: { members?: number; tz?: string; name?: string; pact?: PactSpec | false; participants?: number } = {},
): Promise<GroupFixture> {
  const n = opts.members ?? 3;
  const tz = opts.tz ?? 'America/Los_Angeles';
  const userIds: string[] = [];
  for (let i = 0; i < n; i++) userIds.push(await createUser(db, undefined, `Member ${i + 1}`));
  const ownerId = userIds[0];
  const groupId = await asUser(db, ownerId, (d) =>
    scalar<string>(d, `select public.create_group($1, $2)`, [opts.name ?? 'Test group', tz]),
  );
  const inviteCode = await scalar<string>(db, `select invite_code from public.groups where id = $1`, [groupId]);
  for (const uid of userIds.slice(1)) {
    await asUser(db, uid, (d) => d.query(`select public.join_group($1)`, [inviteCode]));
  }
  let pactId: string | null = null;
  const participantIds: string[] = [];
  if (opts.pact !== false) {
    const p = opts.pact ?? {};
    pactId = await asUser(db, ownerId, (d) =>
      scalar<string>(
        d,
        `select public.create_pact($1, $2, $3::smallint[], $4::time, $5::time, $6, $7)`,
        [
          groupId,
          p.title ?? '9am class',
          p.days ?? [1, 2, 3, 4, 5],
          p.windowOpen === undefined ? '08:00' : p.windowOpen,
          p.deadline ?? '09:00',
          p.stakeCents ?? 500,
          p.tz ?? tz,
        ],
      ),
    );
    const k = opts.participants ?? n;
    for (let i = 0; i < k; i++) {
      await asUser(db, userIds[i], (d) =>
        d.query(`select public.join_pact($1, $2, $3, $4, $5)`, [pactId, 47.6553 + i * 0.01, -122.3035, 100, `place ${i}`]),
      );
      participantIds.push(userIds[i]);
    }
  }
  return { groupId, inviteCode, ownerId, userIds, pactId, participantIds };
}

/** Expect a promise to reject; returns the error (with .code / .message) for further assertions. */
export async function expectError(p: Promise<unknown>, match?: RegExp | string): Promise<any> {
  try {
    await p;
  } catch (e: any) {
    if (match) {
      const msg = String(e?.message ?? e);
      const ok = typeof match === 'string' ? msg.includes(match) : match.test(msg);
      if (!ok) throw new Error(`expected error matching ${match}, got: ${msg}`);
    }
    return e;
  }
  throw new Error(`expected rejection${match ? ` matching ${match}` : ''}, but it resolved`);
}
