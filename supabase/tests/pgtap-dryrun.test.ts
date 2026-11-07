import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb } from './helpers/db';

// PGlite has no pgTAP. This runs pgtap/foundation_test.sql against a minimal shim of the
// pgTAP functions it uses (plan, is, isnt, throws_ok(sql, errcode, msg, desc), lives_ok, finish)
// so the file is known to be correct before it is run for real with `supabase test db`.
const SHIM = `
create schema extensions;
grant usage on schema extensions to public;
create table extensions.tap_log (n serial, ok boolean, descr text);
grant all on extensions.tap_log to public;
grant all on sequence extensions.tap_log_n_seq to public;
create function extensions.plan(int) returns text language sql as $$ select 'plan ' || $1 $$;
create function extensions._r(ok boolean, d text) returns text language plpgsql as $$
begin insert into extensions.tap_log (ok, descr) values (ok, d); return d; end $$;
create function extensions.is(anyelement, anyelement, text) returns text language sql as
  $$ select extensions._r($1 is not distinct from $2, $3 || ' [got ' || coalesce($1::text, 'null') || ']') $$;
create function extensions.isnt(anyelement, anyelement, text) returns text language sql as
  $$ select extensions._r($1 is distinct from $2, $3) $$;
create function extensions.throws_ok(text, text, text, text) returns text language plpgsql as $$
begin execute $1; return extensions._r(false, $4 || ' [no error]');
exception when others then return extensions._r(sqlstate = $2, $4 || ' [' || sqlstate || ' ' || sqlerrm || ']'); end $$;
create function extensions.lives_ok(text, text) returns text language plpgsql as $$
begin execute $1; return extensions._r(true, $2);
exception when others then return extensions._r(false, $2 || ' [' || sqlerrm || ']'); end $$;
create function extensions.finish() returns setof text language sql as $$ select 'done' $$;
`;

it('pgtap/foundation_test.sql passes against a pgTAP shim', async () => {
  const db = await createDb();
  await db.exec(SHIM);
  const src = readFileSync(new URL('./pgtap/foundation_test.sql', import.meta.url), 'utf8');
  const planned = Number(/select plan\((\d+)\)/.exec(src)?.[1]);
  const body = src
    .replace(/create extension if not exists pgtap[^;]*;/, '')
    .replace(/^rollback;\s*$/m, ''); // keep the transaction open so the log can be read
  await db.exec(body);
  const log = (await db.query<{ ok: boolean; descr: string }>(`select ok, descr from extensions.tap_log order by n`)).rows;
  await db.exec('rollback');
  expect(log.length).toBe(planned);
  expect(log.filter((l) => !l.ok).map((l) => l.descr)).toEqual([]);
});
