-- =====================================================================
-- Local development seed. LOCAL ONLY.
--
-- Applied by `supabase db reset` / the first `supabase start` after every migration
-- (config.toml [db.seed]). `supabase db push` never runs it, and it must never be run against a
-- hosted project: it creates two auth users with a known password.
--
-- What it creates (every statement is idempotent; re-running changes nothing):
--   * auth users Alice (alice@example.com) and Bob (bob@example.com), password `password123`,
--     with fixed ids so the rest of the file can reference them;
--   * group "Kane Hall crew" (invite code SEEDKANE01, zone America/Los_Angeles), Alice owner;
--   * pact "9am class" Mon-Fri 08:00-09:00, $5 pledge, with a place for each of them
--     (Kane Hall and Odegaard Library on the UW campus), set through join_pact so the place
--     history and feed events are the real ones;
--   * the next week of instances via generate_instances(7, now()).
-- No check-ins, results or ledger rows: the ledger starts empty.
--
-- It runs on two different `auth.users` tables:
--   * the real GoTrue table (local stack): a full row (encrypted password, confirmed email,
--     provider metadata) plus an auth.identities row, which is what GoTrue needs for
--     signInWithPassword to work;
--   * the PGlite test stub (supabase/tests/helpers/db.ts), which has only (id, email): the DO block
--     detects the missing columns and inserts just those. supabase/tests/seed.test.ts applies this
--     file against the full migration chain on every run.
-- The profile row comes from the handle_new_user trigger; display names are then pinned so both
-- environments show the same names.
-- =====================================================================

do $seed$
declare
  c_alice constant uuid := '11111111-1111-4111-8111-111111111111';
  c_bob   constant uuid := '22222222-2222-4222-8222-222222222222';
  c_group constant uuid := '33333333-3333-4333-8333-333333333333';
  c_pact  constant uuid := '44444444-4444-4444-8444-444444444444';
  c_tz    constant text := 'America/Los_Angeles';
  v_gotrue boolean;
  v_identities boolean;
  v_users record;
begin
  -- -------------------------------------------------------------------
  -- 1. auth users
  -- -------------------------------------------------------------------
  v_gotrue := exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password'
  );
  v_identities := exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id'
  );

  for v_users in
    select * from (values
      (c_alice, 'alice@example.com', 'Alice'),
      (c_bob,   'bob@example.com',   'Bob')
    ) as t(id, email, name)
  loop
    if v_gotrue then
      -- The empty-string token columns matter: GoTrue reads them as non-null strings and a NULL
      -- there makes the user unable to sign in ("converting NULL to string is unsupported").
      execute $sql$
        insert into auth.users (
          instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
          raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
          confirmation_token, recovery_token, email_change_token_new, email_change,
          email_change_token_current, phone_change, phone_change_token, reauthentication_token
        ) values (
          '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
          extensions.crypt('password123', extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('display_name', $3), false, now(), now(),
          '', '', '', '', '', '', '', ''
        )
        on conflict (id) do nothing
      $sql$ using v_users.id, v_users.email, v_users.name;

      if v_identities then
        execute $sql$
          insert into auth.identities (user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
          values ($1, $1::text,
                  jsonb_build_object('sub', $1::text, 'email', $2, 'email_verified', true, 'phone_verified', false),
                  'email', now(), now(), now())
          on conflict (provider_id, provider) do nothing
        $sql$ using v_users.id, v_users.email;
      end if;
    else
      insert into auth.users (id, email) values (v_users.id, v_users.email) on conflict (id) do nothing;
    end if;

    -- handle_new_user created the profile from the metadata (real stack) or the email (stub).
    update public.profiles set display_name = v_users.name where id = v_users.id and display_name <> v_users.name;
  end loop;

  -- -------------------------------------------------------------------
  -- 2. group: fixed id and invite code so the file can be re-run and the code typed into the app
  -- -------------------------------------------------------------------
  insert into public.groups (id, name, invite_code, settlement_tz, created_by)
  values (c_group, 'Kane Hall crew', 'SEEDKANE01', c_tz, c_alice)
  on conflict (id) do nothing;

  insert into public.group_members (group_id, user_id, role)
  values (c_group, c_alice, 'owner'), (c_group, c_bob, 'member')
  on conflict (group_id, user_id) do nothing;

  -- -------------------------------------------------------------------
  -- 3. pact + places. join_pact is called as each user (auth.uid() reads request.jwt.claims)
  --    so pact_participant_places and place_events are exactly what the app would have written.
  -- -------------------------------------------------------------------
  insert into public.pacts (id, group_id, title, days_of_week, window_open_local, deadline_local, stake_cents, tz, created_by)
  values (c_pact, c_group, '9am class', '{1,2,3,4,5}', time '08:00', time '09:00', 500, c_tz, c_alice)
  on conflict (id) do nothing;

  if not exists (select 1 from public.pact_participants where pact_id = c_pact and user_id = c_alice) then
    perform set_config('request.jwt.claims', json_build_object('sub', c_alice, 'role', 'authenticated')::text, true);
    perform public.join_pact(c_pact, 47.65663, -122.30906, 100, 'Kane Hall');
  end if;
  if not exists (select 1 from public.pact_participants where pact_id = c_pact and user_id = c_bob) then
    perform set_config('request.jwt.claims', json_build_object('sub', c_bob, 'role', 'authenticated')::text, true);
    perform public.join_pact(c_pact, 47.65637, -122.31026, 100, 'Odegaard Library');
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- -------------------------------------------------------------------
  -- 4. the coming week of instances (idempotent: unique (pact_id, local_date))
  -- -------------------------------------------------------------------
  perform public.generate_instances(7, now());
end;
$seed$;
