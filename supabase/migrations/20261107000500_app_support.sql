-- App support: things the client and the push function need that the core contract didn't list.
--   1. profiles.venmo_username (users edit their own; used for Venmo deep links)
--   2. users can delete their own push tokens (notifications off / sign out)
--   3. notification_outbox lease + claim_outbox() for the push-outbox Edge Function
--   4. private storage bucket for appeal photos (only where Supabase Storage exists)

-- 1. Venmo username -----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists venmo_username text null
    check (venmo_username is null or venmo_username ~ '^[A-Za-z0-9_-]{5,30}$');

grant update (venmo_username) on public.profiles to authenticated;

-- 2. Push token deletion --------------------------------------------------------------------------
grant delete on public.push_tokens to authenticated;

create policy push_tokens_delete_own on public.push_tokens for delete to authenticated
  using (user_id = auth.uid());

-- 3. Outbox claim with a lease ----------------------------------------------------------------------
-- FOR UPDATE SKIP LOCKED only protects rows until the claim transaction commits, which happens before
-- the Edge Function sends anything. claimed_until hides a claimed row for 5 minutes so an overlapping
-- run can't double-send; the function clears it on retryable failure, and a crashed run's rows come
-- back when the lease expires.
alter table public.notification_outbox
  add column if not exists claimed_until timestamptz null;

create index if not exists notification_outbox_unsent_idx
  on public.notification_outbox (id)
  where sent_at is null;

create or replace function public.claim_outbox(p_limit int default 100, p_now timestamptz default now())
returns setof public.notification_outbox
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  update public.notification_outbox o
     set attempts = o.attempts + 1,
         claimed_until = p_now + interval '5 minutes'
   where o.id in (
           select c.id
             from public.notification_outbox c
            where c.sent_at is null
              and c.attempts < 5
              and (c.claimed_until is null or c.claimed_until <= p_now)
            order by c.id
            limit greatest(coalesce(p_limit, 100), 0)
            for update skip locked
         )
  returning o.*;
$$;

revoke all on function public.claim_outbox(int, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_outbox(int, timestamptz) to service_role;

-- 4. Appeal photo bucket (Supabase Storage only; no-op elsewhere) -----------------------------------
-- Object path convention: <group_id>/<user_id>/<filename>. Uploaders write only under their own user
-- folder in a group they belong to; any member of that group can read.
do $$
begin
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public) values ('review-photos', 'review-photos', false)
      on conflict (id) do nothing;

    execute $p$
      create policy review_photos_insert on storage.objects for insert to authenticated
        with check (
          bucket_id = 'review-photos'
          and (storage.foldername(name))[2] = auth.uid()::text
          and public.is_group_member(((storage.foldername(name))[1])::uuid)
        )
    $p$;

    execute $p$
      create policy review_photos_select on storage.objects for select to authenticated
        using (
          bucket_id = 'review-photos'
          and public.is_group_member(((storage.foldername(name))[1])::uuid)
        )
    $p$;
  end if;
end;
$$;
