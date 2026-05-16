-- ════════════════════════════════════════════════════════════════════════════
-- Withdrawals-live announcement blast (in-app notifications)
--
-- Sends a one-off announcement to every creator letting them know
-- withdrawals are open again on the website. The mobile app is NOT
-- ready yet, so the copy explicitly directs them to selebox.com.
--
-- Audience
-- --------
-- Anyone who could plausibly want to withdraw — broadest reasonable
-- definition without spamming pure-readers:
--   (a) has at least one author_earnings row (ever earned anything)
--   (b) OR has at least one author_withdrawals row (ever requested)
--   (c) OR has profiles.role = 'creator'
--   (d) OR has 'creator' in profiles.roles[]
-- UNION'd and de-duplicated. Banned / suspended profiles excluded.
--
-- Idempotency
-- -----------
-- Each slot (launch / morning / noon / afternoon) gets its own ref so
-- that a user receives ONE notification per slot — but rerunning the
-- same slot is a no-op. The `metadata->>'ref'` guard is the same
-- pattern used in 2026-05-10_credit_notifications_batch20.sql.
--
-- Slots
-- -----
-- Designed to be called 4 times across the day with different slot
-- labels. Each call inserts at most one notification per recipient
-- for that slot. The slots are intentionally separate so a creator
-- who's been away from the app sees the message multiple times — a
-- one-day re-engagement campaign for the withdrawal feature unlock.
--
-- Usage
-- -----
-- Run this whole file ONCE to install the function + send the first
-- blast (slot='launch'). For subsequent slots, just call:
--     select public.send_withdrawals_live_blast('morning');
--     select public.send_withdrawals_live_blast('noon');
--     select public.send_withdrawals_live_blast('afternoon');
--
-- Rollback
-- --------
-- drop function if exists public.send_withdrawals_live_blast(text);
-- Existing notification rows remain in users' bells until they tap.
-- To pull them back:
--     delete from public.notifications
--      where metadata->>'campaign' = 'withdrawals_live_2026_05_17';
-- ════════════════════════════════════════════════════════════════════════════

begin;


-- ──────────────────────────────────────────────────────────────────────
-- 0. Dedupe log table for the push-blast Node companion script.
--    Lives in the same DB so service-role can write to it from the
--    server-side Node script without needing a separate kv store.
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.push_blast_log (
  recipient_id uuid        not null,
  slot         text        not null,
  campaign     text        not null,
  sent_at      timestamptz not null default now(),
  primary key (recipient_id, slot, campaign)
);
alter table public.push_blast_log enable row level security;
-- No policies — only service_role (which bypasses RLS) can read/write.


-- ──────────────────────────────────────────────────────────────────────
-- 1. The reusable blast function (slot-parameterised).
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.send_withdrawals_live_blast(p_slot text)
returns table (
  inserted_count int,
  skipped_count  int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid;
  v_ref_prefix  text;
  v_title       text;
  v_body        text;
  v_inserted    int := 0;
  v_skipped     int := 0;
begin
  -- Guard rails on the slot label so a typo doesn't create a brand-new
  -- campaign axis. Only the four planned slots are accepted.
  if p_slot not in ('launch', 'morning', 'noon', 'afternoon') then
    raise exception 'invalid slot %: expected one of launch | morning | noon | afternoon', p_slot;
  end if;

  -- Resolve the Selebox brand profile as the actor. Same lookup the
  -- credit-notification batch jobs use — keeps the bell renderer's
  -- "actor" column populated with a known account.
  select id into v_actor from public.profiles
   where lower(username) in (
     'selebox', 'selebox_admin', 'selebox_support',
     'selebox_official', 'team_selebox'
   )
   order by created_at asc
   limit 1;

  if v_actor is null then
    raise exception 'no Selebox brand profile found — pick one and rerun';
  end if;

  v_ref_prefix := 'withdrawals_live_2026_05_17::' || p_slot;

  v_title := 'Withdrawals are open again';
  v_body  := 'Currently available on the website only — visit selebox.com to request yours. App support coming back soon. Thanks for your patience 💜';

  -- Build the audience as a CTE so the NOT EXISTS guard runs cleanly
  -- against each candidate. INSERT ... SELECT ... ON CONFLICT isn't
  -- usable here because we don't have a unique constraint on
  -- (recipient_id, metadata->>'ref'); the NOT EXISTS pattern matches
  -- the rest of the announcement-blast migrations.
  with audience as (
    select distinct p.id as recipient_id
      from public.profiles p
     where coalesce(p.is_banned, false)    = false
       and coalesce(p.is_suspended, false) = false
       and (
            p.role = 'creator'
         or 'creator' = any(coalesce(p.roles, array[]::text[]))
         or exists (
              select 1 from public.author_earnings e
               where e.author_id = p.id
             )
         or exists (
              select 1 from public.author_withdrawals w
               where w.author_id = p.id
             )
       )
  ),
  to_send as (
    select a.recipient_id
      from audience a
     where not exists (
       select 1 from public.notifications n
        where n.recipient_id = a.recipient_id
          and n.type         = 'announcement'
          and n.metadata->>'ref' = v_ref_prefix
     )
  ),
  inserted as (
    insert into public.notifications (
      recipient_id, actor_id, type, target_type, target_id,
      parent_target_id, message, preview, metadata, is_read, is_viewed
    )
    select
      t.recipient_id,
      v_actor,
      'announcement',
      'withdrawal',
      null,
      null,
      v_title,
      v_body,
      jsonb_build_object(
        'ref',         v_ref_prefix,
        'campaign',    'withdrawals_live_2026_05_17',
        'slot',        p_slot,
        'title',       v_title,
        'body',        v_body,
        'cta_url',     'https://selebox.com',
        'web_only',    true,
        'deeplink',    '/(payments)/payments'
      ),
      false,
      false
    from to_send t
    returning recipient_id
  )
  select
    (select count(*) from inserted)::int,
    (select count(*) from audience) - (select count(*) from inserted)::int
  into v_inserted, v_skipped;

  return query select v_inserted, v_skipped;
end;
$$;

-- Grant execute to a permission set that includes admin Dashboard SQL
-- users. The dashboard runs as the superuser-equivalent role so this is
-- a no-op for that path; the explicit grant lets a service_role JWT
-- (e.g. from the push-blast Node script) call it too.
grant execute on function public.send_withdrawals_live_blast(text) to service_role;


-- ──────────────────────────────────────────────────────────────────────
-- 2. Send the FIRST slot right now (launch).
--
-- Returns inserted_count + skipped_count so you can eyeball the
-- audience size on the dashboard before scheduling the next three.
-- ──────────────────────────────────────────────────────────────────────
select * from public.send_withdrawals_live_blast('launch');


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after the above commits)
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm the inserted count matches the audience:
--      select count(*)
--        from public.notifications
--       where metadata->>'campaign' = 'withdrawals_live_2026_05_17'
--         and metadata->>'slot'     = 'launch';
--
-- 2. Spot-check one recipient:
--      select recipient_id, message, preview, metadata, is_read
--        from public.notifications
--       where metadata->>'campaign' = 'withdrawals_live_2026_05_17'
--         and metadata->>'slot'     = 'launch'
--       limit 5;
--
-- 3. Run subsequent slots throughout the day:
--      select * from public.send_withdrawals_live_blast('morning');
--      select * from public.send_withdrawals_live_blast('noon');
--      select * from public.send_withdrawals_live_blast('afternoon');
--
-- 4. Confirm a creator with no earnings AND not in role/roles is NOT
--    in the audience (negative test):
--      select 1 from public.profiles p
--       where p.id = '<some pure reader id>'
--         and (
--           p.role = 'creator'
--           or 'creator' = any(coalesce(p.roles, array[]::text[]))
--           or exists (select 1 from author_earnings where author_id = p.id)
--           or exists (select 1 from author_withdrawals where author_id = p.id)
--         );
--    Should return zero rows.
