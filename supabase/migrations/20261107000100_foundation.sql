-- =====================================================================
-- Foundation: enums, tables, ledger invariants, RLS, simple RPCs.
-- Spec: docs/CONTRACT.md. Owner: foundation agent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Privileges baseline.
-- Supabase grants ALL on new public tables/sequences/functions to
-- anon+authenticated by default. From here on, tables and sequences created
-- by the migration role in public are NOT exposed to client roles unless a
-- migration grants them explicitly. service_role keeps Supabase's defaults.
-- NOTE: Postgres still grants EXECUTE on every new function to PUBLIC
-- (not revoked globally, to avoid breaking extensions). Every migration must
-- `revoke all on function ... from public, anon[, authenticated]` itself;
-- tests/foundation.test.ts has a guard that fails if a SECURITY DEFINER
-- function is executable by anon or outside the client RPC allowlist.
-- ---------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.instance_status as enum ('scheduled', 'open', 'closed', 'settled', 'voided');
create type public.result_status as enum ('pending', 'success', 'failed', 'unverified', 'frozen', 'void', 'excluded');
create type public.checkin_verdict as enum ('in_fence', 'out_of_fence', 'unjudgeable', 'rejected_simulated');
create type public.review_kind as enum ('appeal', 'challenge');
create type public.review_status as enum ('open', 'accepted', 'rejected', 'defaulted');
create type public.ledger_account_kind as enum ('member', 'pot', 'carry');
create type public.entry_kind as enum ('stake', 'payout', 'rollover', 'settlement_payment', 'correction');
create type public.obligation_status as enum ('pending', 'marked_paid', 'confirmed', 'superseded');

-- ---------------------------------------------------------------------
-- Validation helpers (pure; usable by any agent)
-- ---------------------------------------------------------------------

-- True iff p_tz is a real IANA zone name. AT TIME ZONE alone also accepts
-- abbreviations ('PST') and POSIX offsets ('+05', 'foo+5'), which would
-- silently ignore DST, so the name must also appear in pg_timezone_names.
create function public.is_valid_tz(p_tz text) returns boolean
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_tz is null or p_tz = '' or p_tz <> btrim(p_tz) then
    return false;
  end if;
  perform now() at time zone p_tz;
  return exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz);
exception when others then
  return false;
end;
$$;

-- ISO weekdays 1..7, at least one, no nulls, no duplicates, one-dimensional.
create function public.valid_days_of_week(p_days smallint[]) returns boolean
language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select p_days is not null
     and coalesce(array_ndims(p_days), 0) = 1
     and cardinality(p_days) between 1 and 7
     and array_position(p_days, null) is null
     and p_days <@ '{1,2,3,4,5,6,7}'::smallint[]
     and cardinality(p_days) = (select count(distinct d) from unnest(p_days) d)
$$;

-- Generic trigger: TG_ARGV[0] names a text column that must be an IANA zone.
create function public.trg_validate_tz() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_tz text := to_jsonb(new) ->> tg_argv[0];
begin
  if not public.is_valid_tz(v_tz) then
    raise exception 'invalid time zone: % (must be an IANA zone name)', coalesce(v_tz, 'null')
      using errcode = '22023';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 50),
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  invite_code text not null unique,
  settlement_tz text not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);
create trigger groups_validate_tz before insert or update of settlement_tz on public.groups
  for each row execute function public.trg_validate_tz('settlement_tz');

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  left_at timestamptz null,
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id) where left_at is null;

create table public.pacts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  days_of_week smallint[] not null check (public.valid_days_of_week(days_of_week)),
  window_open_local time not null,
  deadline_local time not null,
  stake_cents int not null default 500 check (stake_cents between 1 and 10000),
  tz text not null,
  paused boolean not null default false,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint pacts_window_before_deadline check (window_open_local < deadline_local)
);
create index pacts_group_idx on public.pacts (group_id);
create trigger pacts_validate_tz before insert or update of tz on public.pacts
  for each row execute function public.trg_validate_tz('tz');

create table public.pact_participants (
  pact_id uuid not null references public.pacts (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  place_lat float8 not null check (place_lat between -90 and 90),
  place_lng float8 not null check (place_lng between -180 and 180),
  place_radius_m int not null check (place_radius_m between 25 and 500),
  place_label text null check (place_label is null or char_length(place_label) <= 80),
  joined_at timestamptz not null default now(),
  left_at timestamptz null,
  primary key (pact_id, user_id)
);
create index pact_participants_user_idx on public.pact_participants (user_id);

create table public.pact_instances (
  id uuid primary key default gen_random_uuid(),
  pact_id uuid not null references public.pacts (id) on delete cascade,
  local_date date not null,
  window_open_at timestamptz not null,
  deadline_at timestamptz not null,
  status public.instance_status not null default 'scheduled',
  carry_in_cents bigint null,
  closed_at timestamptz null,
  unique (pact_id, local_date),
  constraint pact_instances_window_before_deadline check (window_open_at < deadline_at)
);
create index pact_instances_status_open_idx on public.pact_instances (status, window_open_at);
create index pact_instances_status_deadline_idx on public.pact_instances (status, deadline_at);

create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.pact_instances (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  client_captured_at timestamptz null,
  server_received_at timestamptz not null default now(),
  lat float8 null,
  lng float8 null,
  accuracy_m float8 null,
  distance_m float8 null,
  is_simulated boolean not null default false,
  verdict public.checkin_verdict not null
);
create index checkins_instance_user_idx on public.checkins (instance_id, user_id);
create index checkins_received_with_location_idx on public.checkins (server_received_at) where lat is not null or lng is not null;

create table public.freezes (
  id uuid primary key default gen_random_uuid(),
  pact_id uuid not null references public.pacts (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  instance_id uuid not null references public.pact_instances (id) on delete cascade,
  declared_at timestamptz not null default now(),
  iso_week text not null,
  unique (pact_id, user_id, iso_week)
);
create index freezes_instance_idx on public.freezes (instance_id);

create table public.results (
  instance_id uuid not null references public.pact_instances (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  status public.result_status not null default 'pending',
  first_success_at timestamptz null,
  decided_at timestamptz null default now(),
  primary key (instance_id, user_id)
);
create index results_user_idx on public.results (user_id);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.pact_instances (id) on delete cascade,
  subject_user_id uuid not null references public.profiles (id),
  opened_by uuid not null references public.profiles (id),
  kind public.review_kind not null,
  reason text null,
  photo_path text null,
  status public.review_status not null default 'open',
  opened_at timestamptz not null default now(),
  resolved_at timestamptz null
);
create index reviews_instance_idx on public.reviews (instance_id);

create table public.review_votes (
  review_id uuid not null references public.reviews (id) on delete cascade,
  voter_id uuid not null references public.profiles (id),
  supports boolean not null,
  cast_at timestamptz not null default now(),
  primary key (review_id, voter_id)
);

-- Ledger ---------------------------------------------------------------
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  kind public.ledger_account_kind not null,
  user_id uuid null references public.profiles (id),
  instance_id uuid null references public.pact_instances (id),
  pact_id uuid null references public.pacts (id),
  constraint ledger_accounts_shape check (
       (kind = 'member' and user_id is not null and instance_id is null and pact_id is null)
    or (kind = 'pot'    and instance_id is not null and user_id is null)
    or (kind = 'carry'  and pact_id is not null and user_id is null and instance_id is null)
  )
);
create unique index ledger_accounts_member_uniq on public.ledger_accounts (group_id, user_id) where kind = 'member';
create unique index ledger_accounts_pot_uniq on public.ledger_accounts (instance_id) where kind = 'pot';
create unique index ledger_accounts_carry_uniq on public.ledger_accounts (pact_id) where kind = 'carry';

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  kind public.entry_kind not null,
  idempotency_key text not null unique check (btrim(idempotency_key) <> ''),
  instance_id uuid null references public.pact_instances (id),
  memo text null,
  created_at timestamptz not null default now()
);
create index ledger_entries_group_idx on public.ledger_entries (group_id);
create index ledger_entries_instance_idx on public.ledger_entries (instance_id);

create table public.ledger_lines (
  id bigserial primary key,
  entry_id uuid not null references public.ledger_entries (id),
  account_id uuid not null references public.ledger_accounts (id),
  amount_cents bigint not null check (amount_cents <> 0)
);
create index ledger_lines_entry_idx on public.ledger_lines (entry_id);
create index ledger_lines_account_idx on public.ledger_lines (account_id);

-- Settlement -----------------------------------------------------------
create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  week_start date not null check (extract(isodow from week_start) = 1),
  ran_at timestamptz not null default now(),
  unique (group_id, week_start)
);

create table public.obligations (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.settlements (id),
  group_id uuid not null references public.groups (id),
  from_user uuid not null references public.profiles (id),
  to_user uuid not null references public.profiles (id),
  amount_cents bigint not null check (amount_cents > 0),
  status public.obligation_status not null default 'pending',
  marked_paid_at timestamptz null,
  confirmed_at timestamptz null,
  constraint obligations_distinct_parties check (from_user <> to_user)
);
create index obligations_group_idx on public.obligations (group_id, status);
create index obligations_settlement_idx on public.obligations (settlement_id);

-- Notifications --------------------------------------------------------
create table public.notification_outbox (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz null,
  attempts int not null default 0,
  last_error text null
);
create index notification_outbox_unsent_idx on public.notification_outbox (created_at) where sent_at is null;
create index notification_outbox_user_idx on public.notification_outbox (user_id);

create table public.push_tokens (
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null check (char_length(token) between 1 and 512),
  platform text not null check (platform in ('ios', 'android', 'web')),
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);
create index push_tokens_token_idx on public.push_tokens (token);

-- ---------------------------------------------------------------------
-- Group membership cap: at most 8 current members.
-- Locks the group row so concurrent joins serialize.
-- ---------------------------------------------------------------------
create function public.trg_group_members_cap() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_count int;
begin
  if new.left_at is null and (tg_op = 'INSERT' or old.left_at is not null or old.group_id <> new.group_id) then
    perform 1 from public.groups where id = new.group_id for update;
    select count(*) into v_count
      from public.group_members
     where group_id = new.group_id and left_at is null and user_id <> new.user_id;
    if v_count >= 8 then
      raise exception 'group is full: at most 8 current members' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger group_members_cap before insert or update on public.group_members
  for each row execute function public.trg_group_members_cap();

-- ---------------------------------------------------------------------
-- Ledger integrity triggers
-- ---------------------------------------------------------------------

-- Append-only (applies to every role, including table owner and service_role).
create function public.trg_ledger_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception '% is append-only (% not allowed); post a correction entry instead', tg_table_name, tg_op
    using errcode = '55000';
end;
$$;
create trigger ledger_entries_append_only before update or delete on public.ledger_entries
  for each row execute function public.trg_ledger_append_only();
create trigger ledger_entries_no_truncate before truncate on public.ledger_entries
  for each statement execute function public.trg_ledger_append_only();
create trigger ledger_lines_append_only before update or delete on public.ledger_lines
  for each row execute function public.trg_ledger_append_only();
create trigger ledger_lines_no_truncate before truncate on public.ledger_lines
  for each statement execute function public.trg_ledger_append_only();
create trigger ledger_accounts_immutable before update on public.ledger_accounts
  for each row execute function public.trg_ledger_append_only();

-- Accounts must reference objects of their own group.
create function public.trg_ledger_account_consistency() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_group uuid;
  v_pact uuid;
begin
  if new.kind = 'member' then
    if not exists (select 1 from public.group_members where group_id = new.group_id and user_id = new.user_id) then
      raise exception 'member account: user % has never been a member of group %', new.user_id, new.group_id
        using errcode = '23514';
    end if;
  elsif new.kind = 'pot' then
    select p.group_id, p.id into v_group, v_pact
      from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where i.id = new.instance_id;
    if v_group is distinct from new.group_id then
      raise exception 'pot account: instance % does not belong to group %', new.instance_id, new.group_id
        using errcode = '23514';
    end if;
    if new.pact_id is null then
      new.pact_id := v_pact;
    elsif new.pact_id <> v_pact then
      raise exception 'pot account: instance % does not belong to pact %', new.instance_id, new.pact_id
        using errcode = '23514';
    end if;
  elsif new.kind = 'carry' then
    select group_id into v_group from public.pacts where id = new.pact_id;
    if v_group is distinct from new.group_id then
      raise exception 'carry account: pact % does not belong to group %', new.pact_id, new.group_id
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger ledger_accounts_consistency before insert on public.ledger_accounts
  for each row execute function public.trg_ledger_account_consistency();

create function public.trg_ledger_entry_consistency() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.instance_id is not null and not exists (
    select 1 from public.pact_instances i join public.pacts p on p.id = i.pact_id
     where i.id = new.instance_id and p.group_id = new.group_id
  ) then
    raise exception 'ledger entry: instance % does not belong to group %', new.instance_id, new.group_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger ledger_entries_consistency before insert on public.ledger_entries
  for each row execute function public.trg_ledger_entry_consistency();

create function public.trg_ledger_line_consistency() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.ledger_entries e join public.ledger_accounts a on a.group_id = e.group_id
     where e.id = new.entry_id and a.id = new.account_id
  ) then
    raise exception 'ledger line: account % is not in the group of entry %', new.account_id, new.entry_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger ledger_lines_consistency before insert on public.ledger_lines
  for each row execute function public.trg_ledger_line_consistency();

-- Zero-sum, checked at commit (deferred), so an entry may be built line by line.
create function public.trg_ledger_entry_balanced() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entry uuid;
  v_n bigint;
  v_sum numeric;
begin
  if tg_table_name = 'ledger_entries' then
    v_entry := new.id;
  else
    v_entry := new.entry_id;
  end if;
  select count(*), coalesce(sum(amount_cents), 0) into v_n, v_sum
    from public.ledger_lines where entry_id = v_entry;
  if v_n = 0 then
    raise exception 'ledger entry % has no lines', v_entry using errcode = '23514';
  end if;
  if v_sum <> 0 then
    raise exception 'ledger entry % lines sum to % (must sum to zero)', v_entry, v_sum using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger ledger_entries_balanced after insert on public.ledger_entries
  deferrable initially deferred for each row execute function public.trg_ledger_entry_balanced();
create constraint trigger ledger_lines_balanced after insert on public.ledger_lines
  deferrable initially deferred for each row execute function public.trg_ledger_entry_balanced();

-- ---------------------------------------------------------------------
-- Ledger helpers (internal: service_role / other SECURITY DEFINER code only)
-- ---------------------------------------------------------------------

-- Get-or-create. Identity: member=(group,user), pot=(instance), carry=(pact).
-- For pots, pact_id is filled from the instance when omitted.
create function public.ensure_account(
  p_group uuid,
  p_kind public.ledger_account_kind,
  p_user uuid,
  p_instance uuid,
  p_pact uuid
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_group is null or p_kind is null then
    raise exception 'ensure_account: group and kind are required' using errcode = '22023';
  end if;
  loop
    select id into v_id
      from public.ledger_accounts
     where group_id = p_group
       and kind = p_kind
       and case p_kind
             when 'member' then user_id = p_user
             when 'pot' then instance_id = p_instance
             else pact_id = p_pact
           end;
    if found then
      return v_id;
    end if;
    begin
      insert into public.ledger_accounts (group_id, kind, user_id, instance_id, pact_id)
      values (
        p_group,
        p_kind,
        case when p_kind = 'member' then p_user end,
        case when p_kind = 'pot' then p_instance end,
        case when p_kind in ('pot', 'carry') then p_pact end
      )
      returning id into v_id;
      return v_id;
    exception when unique_violation then
      -- concurrent creator won; loop and read it
    end;
  end loop;
end;
$$;

-- Post a balanced journal entry. p_lines: [{"account_id": uuid, "amount_cents": int}, ...]
-- Lines are merged per account and zero lines dropped. Returns:
--   new entry id; or the existing id when the key exists with identical
--   (group, kind, instance, merged lines); or null when nothing nets out
--   (and the key is unused). Reusing a key with different content raises.
create function public.post_entry(
  p_group uuid,
  p_kind public.entry_kind,
  p_key text,
  p_instance uuid,
  p_memo text,
  p_lines jsonb
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lines jsonb;
  v_sum numeric;
  v_id uuid;
  v_existing public.ledger_entries%rowtype;
  v_existing_lines jsonb;
begin
  if p_group is null or p_kind is null then
    raise exception 'post_entry: group and kind are required' using errcode = '22023';
  end if;
  if p_key is null or btrim(p_key) = '' then
    raise exception 'post_entry: idempotency key is required' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'post_entry: lines must be a json array' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
     where jsonb_typeof(e) <> 'object'
        or jsonb_typeof(e -> 'account_id') is distinct from 'string'
        or jsonb_typeof(e -> 'amount_cents') is distinct from 'number'
        or (e -> 'amount_cents')::numeric <> trunc((e -> 'amount_cents')::numeric)
  ) then
    raise exception 'post_entry: each line needs account_id (uuid) and integer amount_cents' using errcode = '22023';
  end if;

  select coalesce(sum((e -> 'amount_cents')::numeric), 0) into v_sum from jsonb_array_elements(p_lines) e;
  if v_sum <> 0 then
    raise exception 'post_entry %: lines sum to % (must sum to zero)', p_key, v_sum using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'amount_cents', amount_cents) order by account_id), '[]'::jsonb)
    into v_lines
    from (
      select (e ->> 'account_id')::uuid as account_id, sum((e -> 'amount_cents')::numeric)::bigint as amount_cents
        from jsonb_array_elements(p_lines) e
       group by 1
      having sum((e -> 'amount_cents')::numeric) <> 0
    ) m;

  if v_lines = '[]'::jsonb then
    if exists (select 1 from public.ledger_entries where idempotency_key = p_key) then
      raise exception 'post_entry: idempotency key % already used with different lines', p_key using errcode = '23505';
    end if;
    return null;
  end if;

  insert into public.ledger_entries (group_id, kind, idempotency_key, instance_id, memo)
  values (p_group, p_kind, p_key, p_instance, p_memo)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.ledger_entries where idempotency_key = p_key;
    select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'amount_cents', amount_cents) order by account_id), '[]'::jsonb)
      into v_existing_lines
      from (
        select account_id, sum(amount_cents) as amount_cents
          from public.ledger_lines where entry_id = v_existing.id
         group by 1
      ) m;
    if v_existing.group_id <> p_group
       or v_existing.kind <> p_kind
       or v_existing.instance_id is distinct from p_instance
       or v_existing_lines <> v_lines then
      raise exception 'post_entry: idempotency key % already used with different content', p_key using errcode = '23505';
    end if;
    return v_existing.id;
  end if;

  insert into public.ledger_lines (entry_id, account_id, amount_cents)
  select v_id, l.account_id, l.amount_cents
    from jsonb_to_recordset(v_lines) as l(account_id uuid, amount_cents bigint);

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Balance views (security_invoker: callers only see rows RLS allows)
-- ---------------------------------------------------------------------
create view public.account_balances with (security_invoker = true) as
select a.id as account_id,
       a.group_id,
       a.kind,
       a.user_id,
       a.pact_id,
       a.instance_id,
       coalesce(sum(l.amount_cents), 0)::bigint as balance_cents
  from public.ledger_accounts a
  left join public.ledger_lines l on l.account_id = a.id
 group by a.id;

create view public.member_balances with (security_invoker = true) as
select group_id, user_id, balance_cents
  from public.account_balances
 where kind = 'member';

-- ---------------------------------------------------------------------
-- Access-control helpers (SECURITY DEFINER so policies don't recurse)
-- ---------------------------------------------------------------------
create function public.is_group_member(p_group uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.group_members
     where group_id = p_group and user_id = auth.uid() and left_at is null
  )
$$;

create function public.is_pact_participant(p_pact uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.pact_participants
     where pact_id = p_pact and user_id = auth.uid() and left_at is null
  )
$$;

create function public.is_pact_group_member(p_pact uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.pacts p
      join public.group_members m on m.group_id = p.group_id
     where p.id = p_pact and m.user_id = auth.uid() and m.left_at is null
  )
$$;

create function public.is_instance_group_member(p_instance uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.pact_instances i
      join public.pacts p on p.id = i.pact_id
      join public.group_members m on m.group_id = p.group_id
     where i.id = p_instance and m.user_id = auth.uid() and m.left_at is null
  )
$$;

-- Caller is a current member of some group in which p_user is (or was) a member.
create function public.shares_group_with(p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.group_members me
      join public.group_members them on them.group_id = me.group_id
     where me.user_id = auth.uid() and me.left_at is null and them.user_id = p_user
  )
$$;

-- ---------------------------------------------------------------------
-- Row-level security: enabled everywhere; clients read only.
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.pacts enable row level security;
alter table public.pact_participants enable row level security;
alter table public.pact_instances enable row level security;
alter table public.checkins enable row level security;
alter table public.freezes enable row level security;
alter table public.results enable row level security;
alter table public.reviews enable row level security;
alter table public.review_votes enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.ledger_lines enable row level security;
alter table public.settlements enable row level security;
alter table public.obligations enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.push_tokens enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_group_with(id));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy groups_select on public.groups for select to authenticated
  using (public.is_group_member(id));
create policy group_members_select on public.group_members for select to authenticated
  using (public.is_group_member(group_id));
create policy pacts_select on public.pacts for select to authenticated
  using (public.is_group_member(group_id));
create policy pact_participants_select on public.pact_participants for select to authenticated
  using (public.is_pact_group_member(pact_id));
create policy pact_instances_select on public.pact_instances for select to authenticated
  using (public.is_pact_group_member(pact_id));
create policy checkins_select on public.checkins for select to authenticated
  using (public.is_instance_group_member(instance_id));
create policy freezes_select on public.freezes for select to authenticated
  using (public.is_pact_group_member(pact_id));
create policy results_select on public.results for select to authenticated
  using (public.is_instance_group_member(instance_id));
create policy reviews_select on public.reviews for select to authenticated
  using (public.is_instance_group_member(instance_id));
create policy review_votes_select on public.review_votes for select to authenticated
  using (public.is_instance_group_member((select r.instance_id from public.reviews r where r.id = review_id)));
create policy ledger_accounts_select on public.ledger_accounts for select to authenticated
  using (public.is_group_member(group_id));
create policy ledger_entries_select on public.ledger_entries for select to authenticated
  using (public.is_group_member(group_id));
create policy ledger_lines_select on public.ledger_lines for select to authenticated
  using (public.is_group_member((select e.group_id from public.ledger_entries e where e.id = entry_id)));
create policy settlements_select on public.settlements for select to authenticated
  using (public.is_group_member(group_id));
-- Parties keep seeing their own obligations after leaving the group (they may still owe / be owed).
create policy obligations_select on public.obligations for select to authenticated
  using (public.is_group_member(group_id) or from_user = auth.uid() or to_user = auth.uid());
create policy notification_outbox_select_own on public.notification_outbox for select to authenticated
  using (user_id = auth.uid());
create policy push_tokens_select_own on public.push_tokens for select to authenticated
  using (user_id = auth.uid());

-- Table privileges: clients may SELECT (RLS-filtered) and update their own display_name. Nothing else.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------
-- Profiles from auth.users (Supabase convention)
-- ---------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_row jsonb := to_jsonb(new);  -- works whether or not raw_user_meta_data exists (test stub)
  v_name text;
begin
  v_name := coalesce(
    nullif(btrim(v_row -> 'raw_user_meta_data' ->> 'display_name'), ''),
    nullif(btrim(v_row -> 'raw_user_meta_data' ->> 'full_name'), ''),
    nullif(btrim(v_row -> 'raw_user_meta_data' ->> 'name'), ''),
    nullif(btrim(split_part(coalesce(v_row ->> 'email', ''), '@', 1)), ''),
    'Player'
  );
  insert into public.profiles (id, display_name)
  values (new.id, left(v_name, 50))
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$
begin
  if to_regclass('auth.users') is not null then
    drop trigger if exists on_auth_user_created on auth.users;
    create trigger on_auth_user_created after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Client RPCs
-- Error codes: 28000 not authenticated, 42501 not allowed,
--              P0002 not found, 22023 invalid argument, 23514 rule violated.
-- ---------------------------------------------------------------------

-- 10 chars of Crockford base32 from a v4 UUID's random bytes (50 bits).
create function public.gen_invite_code() returns text
language plpgsql volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code text := '';
  i int;
begin
  -- skip bytes 6 and 8 (they carry the UUID version/variant bits)
  foreach i in array array[0, 1, 2, 3, 4, 5, 9, 10, 11, 12] loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  return v_code;
end;
$$;

create function public.create_group(p_name text, p_settlement_tz text) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(p_name);
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 80 then
    raise exception 'group name must be 1 to 80 characters' using errcode = '22023';
  end if;
  if not public.is_valid_tz(p_settlement_tz) then
    raise exception 'invalid time zone: % (must be an IANA zone name)', coalesce(p_settlement_tz, 'null')
      using errcode = '22023';
  end if;
  loop
    begin
      insert into public.groups (name, invite_code, settlement_tz, created_by)
      values (v_name, public.gen_invite_code(), p_settlement_tz, v_uid)
      returning id into v_id;
      exit;
    exception when unique_violation then
      -- invite code collision; draw again
    end;
  end loop;
  insert into public.group_members (group_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end;
$$;

create function public.join_group(p_invite_code text) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := translate(upper(btrim(coalesce(p_invite_code, ''))), 'OIL', '011');
  v_group uuid;
  v_left timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select id into v_group from public.groups where invite_code = v_code for update;
  if v_group is null then
    raise exception 'invalid invite code' using errcode = 'P0002';
  end if;
  select left_at into v_left from public.group_members where group_id = v_group and user_id = v_uid;
  if found then
    if v_left is null then
      return v_group;  -- already a member
    end if;
    update public.group_members
       set left_at = null, role = 'member', joined_at = now()
     where group_id = v_group and user_id = v_uid;
  else
    insert into public.group_members (group_id, user_id, role) values (v_group, v_uid, 'member');
  end if;
  return v_group;
end;
$$;

create function public.leave_group(p_group uuid) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  perform 1 from public.groups where id = p_group for update;
  select role into v_role from public.group_members
   where group_id = p_group and user_id = v_uid and left_at is null;
  if v_role is null then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;

  -- No dodging a stake: refuse while on the roster of an instance (of this group's pacts) that is
  -- open, or due but not yet opened by the tick. Same roster rule as _instance_participants.
  if exists (
    select 1
      from public.pact_instances i
      join public.pacts p on p.id = i.pact_id
      join public.pact_participants pp on pp.pact_id = i.pact_id and pp.user_id = v_uid
     where p.group_id = p_group
       and pp.joined_at <= i.window_open_at
       and (pp.left_at is null or pp.left_at > i.window_open_at)
       and (i.status = 'open'
            or (i.status = 'scheduled' and not p.paused and i.window_open_at <= now() and now() < i.deadline_at))
  ) then
    raise exception 'cannot leave while a check-in window you are part of is open or awaiting its result'
      using errcode = '23514';
  end if;

  update public.group_members set left_at = now(), role = 'member'
   where group_id = p_group and user_id = v_uid;

  update public.pact_participants pp set left_at = now()
    from public.pacts p
   where p.id = pp.pact_id and p.group_id = p_group and pp.user_id = v_uid and pp.left_at is null;

  if v_role = 'owner' then
    update public.group_members set role = 'owner'
     where (group_id, user_id) = (
       select group_id, user_id from public.group_members
        where group_id = p_group and left_at is null
        order by joined_at, user_id
        limit 1
     );
  end if;
end;
$$;

create function public.create_pact(
  p_group uuid,
  p_title text,
  p_days smallint[],
  p_window_open time,
  p_deadline time,
  p_stake_cents int,
  p_tz text
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := btrim(p_title);
  v_days smallint[];
  v_open time;
  v_stake int := coalesce(p_stake_cents, 500);
  v_tz text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.is_group_member(p_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if v_title is null or char_length(v_title) not between 1 and 80 then
    raise exception 'pact title must be 1 to 80 characters' using errcode = '22023';
  end if;
  if p_days is not null and array_position(p_days, null) is null then
    select array_agg(distinct d order by d) into v_days from unnest(p_days) d;
  end if;
  if not coalesce(public.valid_days_of_week(v_days), false) then
    raise exception 'days_of_week must list ISO days 1 (Mon) to 7 (Sun), at least one' using errcode = '22023';
  end if;
  if p_deadline is null then
    raise exception 'deadline is required' using errcode = '22023';
  end if;
  v_open := coalesce(
    p_window_open,
    case when p_deadline >= time '01:00' then p_deadline - interval '1 hour' else time '00:00' end
  );
  if v_open >= p_deadline then
    raise exception 'window open time must be before the deadline on the same local day' using errcode = '22023';
  end if;
  if v_stake not between 1 and 10000 then
    raise exception 'stake must be between 1 and 10000 cents' using errcode = '22023';
  end if;
  v_tz := coalesce(p_tz, (select settlement_tz from public.groups where id = p_group));
  if not public.is_valid_tz(v_tz) then
    raise exception 'invalid time zone: % (must be an IANA zone name)', coalesce(v_tz, 'null') using errcode = '22023';
  end if;

  insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, stake_cents, tz, created_by)
  values (p_group, v_title, v_days, v_open, p_deadline, v_stake, v_tz, v_uid)
  returning id into v_id;
  return v_id;
end;
$$;

-- Join a pact or update your place. Once any instance of the pact has reached window_open_at
-- (and until it is closed), only an unchanged place (label edits allowed) is accepted, so nobody
-- can move their fence to wherever they happen to be, or (re)join mid-window.
-- Place history (pact_participant_places, created in 20261107000200): the first place is in
-- effect at once; any later change takes effect 12 hours after the request (replacing a change
-- still pending), so a fence cannot be moved right before a window either. pact_participants'
-- place columns hold the requested place (the one the app shows).
create function public.join_pact(
  p_pact uuid,
  p_lat float8,
  p_lng float8,
  p_radius_m int,
  p_label text
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_label text := nullif(btrim(p_label), '');
  v_cur public.pact_participants%rowtype;
  v_same boolean;
  v_eff record;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select group_id into v_group from public.pacts where id = p_pact;
  if v_group is null then
    raise exception 'pact not found' using errcode = 'P0002';
  end if;
  if not public.is_group_member(v_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if p_lat is null or not (p_lat between -90 and 90) then
    raise exception 'place_lat must be between -90 and 90' using errcode = '22023';
  end if;
  if p_lng is null or not (p_lng between -180 and 180) then
    raise exception 'place_lng must be between -180 and 180' using errcode = '22023';
  end if;
  if p_radius_m is null or p_radius_m not between 25 and 500 then
    raise exception 'place_radius_m must be between 25 and 500' using errcode = '22023';
  end if;
  if v_label is not null and char_length(v_label) > 80 then
    raise exception 'place label must be at most 80 characters' using errcode = '22023';
  end if;

  perform 1 from public.pacts where id = p_pact for update;
  select * into v_cur from public.pact_participants where pact_id = p_pact and user_id = v_uid for update;
  v_same := v_cur.user_id is not null
            and v_cur.place_lat = p_lat and v_cur.place_lng = p_lng and v_cur.place_radius_m = p_radius_m;

  if not (v_same and v_cur.left_at is null) and exists (
    select 1 from public.pact_instances
     where pact_id = p_pact
       and (status = 'open' or (window_open_at <= now() and status not in ('closed', 'settled', 'voided')))
  ) then
    raise exception 'cannot join, rejoin or change your place once a check-in window has opened (until it closes)'
      using errcode = '23514';
  end if;

  if v_cur.user_id is null then
    insert into public.pact_participants (pact_id, user_id, place_lat, place_lng, place_radius_m, place_label)
    values (p_pact, v_uid, p_lat, p_lng, p_radius_m, v_label);
    insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from)
    values (p_pact, v_uid, p_lat, p_lng, p_radius_m, v_label, now());
    return;
  end if;

  -- rows without history (inserted outside join_pact): their place has applied since they joined
  insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from)
  select v_cur.pact_id, v_cur.user_id, v_cur.place_lat, v_cur.place_lng, v_cur.place_radius_m, v_cur.place_label,
         least(v_cur.joined_at, now())
   where not exists (select 1 from public.pact_participant_places where pact_id = p_pact and user_id = v_uid);

  if not v_same then
    -- a new request replaces any change that has not taken effect yet
    delete from public.pact_participant_places
     where pact_id = p_pact and user_id = v_uid and effective_from > now();
    select lat, lng, radius_m into v_eff from public.pact_participant_places
     where pact_id = p_pact and user_id = v_uid and effective_from <= now()
     order by effective_from desc limit 1;
    if v_eff.lat is null or not (v_eff.lat = p_lat and v_eff.lng = p_lng and v_eff.radius_m = p_radius_m) then
      insert into public.pact_participant_places (pact_id, user_id, lat, lng, radius_m, label, effective_from)
      values (p_pact, v_uid, p_lat, p_lng, p_radius_m, v_label, now() + interval '12 hours');
    end if;
  end if;

  update public.pact_participants
     set place_lat = p_lat,
         place_lng = p_lng,
         place_radius_m = p_radius_m,
         place_label = v_label,
         joined_at = case when left_at is null then joined_at else now() end,
         left_at = null
   where pact_id = p_pact and user_id = v_uid;
end;
$$;

create function public.set_pact_paused(p_pact uuid, p_paused boolean) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_creator uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select group_id, created_by into v_group, v_creator from public.pacts where id = p_pact;
  if v_group is null then
    raise exception 'pact not found' using errcode = 'P0002';
  end if;
  if not public.is_group_member(v_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if v_creator <> v_uid and not exists (
    select 1 from public.group_members
     where group_id = v_group and user_id = v_uid and role = 'owner' and left_at is null
  ) then
    raise exception 'only the group owner or the pact creator can pause or resume this pact' using errcode = '42501';
  end if;
  if p_paused is null then
    raise exception 'paused must be true or false' using errcode = '22023';
  end if;
  update public.pacts set paused = p_paused where id = p_pact;
end;
$$;

-- A token belongs to one account: re-registering on another account moves it.
create function public.register_push_token(p_token text, p_platform text) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_token text := btrim(p_token);
  v_platform text := lower(btrim(p_platform));
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_token is null or char_length(v_token) not between 1 and 512 then
    raise exception 'push token is required (max 512 characters)' using errcode = '22023';
  end if;
  if v_platform is null or v_platform not in ('ios', 'android', 'web') then
    raise exception 'platform must be ios, android or web' using errcode = '22023';
  end if;
  delete from public.push_tokens where token = v_token and user_id <> v_uid;
  insert into public.push_tokens (user_id, token, platform, updated_at)
  values (v_uid, v_token, v_platform, now())
  on conflict (user_id, token) do update set platform = excluded.platform, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges (explicit, regardless of defaults above)
-- ---------------------------------------------------------------------
revoke all on function public.ensure_account(uuid, public.ledger_account_kind, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.post_entry(uuid, public.entry_kind, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.gen_invite_code() from public, anon, authenticated;
grant execute on function public.ensure_account(uuid, public.ledger_account_kind, uuid, uuid, uuid) to service_role;
grant execute on function public.post_entry(uuid, public.entry_kind, text, uuid, text, jsonb) to service_role;

-- Used inside RLS policies, so the querying role needs EXECUTE.
revoke all on function public.is_group_member(uuid) from public, anon;
revoke all on function public.is_pact_participant(uuid) from public, anon;
revoke all on function public.is_pact_group_member(uuid) from public, anon;
revoke all on function public.is_instance_group_member(uuid) from public, anon;
revoke all on function public.shares_group_with(uuid) from public, anon;
grant execute on function public.is_group_member(uuid) to authenticated, service_role;
grant execute on function public.is_pact_participant(uuid) to authenticated, service_role;
grant execute on function public.is_pact_group_member(uuid) to authenticated, service_role;
grant execute on function public.is_instance_group_member(uuid) to authenticated, service_role;
grant execute on function public.shares_group_with(uuid) to authenticated, service_role;
grant execute on function public.is_valid_tz(text) to authenticated, service_role;
grant execute on function public.valid_days_of_week(smallint[]) to authenticated, service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.create_group(text, text)',
    'public.join_group(text)',
    'public.leave_group(uuid)',
    'public.create_pact(uuid, text, smallint[], time, time, int, text)',
    'public.join_pact(uuid, float8, float8, int, text)',
    'public.set_pact_paused(uuid, boolean)',
    'public.register_push_token(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
