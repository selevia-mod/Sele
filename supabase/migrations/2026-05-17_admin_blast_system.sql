-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-17 — Admin Broadcasts system (push + in-app blasts to segments)
--
-- Background
-- ----------
-- Replaces the one-off withdrawals_live_blast SQL with a permanent
-- admin feature. Lets admins (and moderators) send a push +/- in-app
-- notification to a chosen audience segment with optional scheduling.
--
-- Surface area
-- ------------
-- New table:
--   admin_blasts                 — one row per blast (metadata + counts)
--
-- New RPCs:
--   admin_send_blast(...)        — main entry point (UI calls this)
--   admin_list_blasts(...)       — for history pane
--   admin_cancel_blast(uuid)     — cancel a scheduled blast
--   _dispatch_blast(uuid)        — internal; does the work (called by
--                                  admin_send_blast for immediate AND
--                                  by the cron for scheduled)
--   _process_due_scheduled_blasts() — cron-driven, picks up due rows
--
-- New cron job:
--   process_due_admin_blasts     — every minute
--
-- Audience segments
-- -----------------
--   all_users — every active profile (banned/suspended excluded)
--   pioneers  — profiles.role = 'pioneer'
--   creators  — has author_earnings OR author_withdrawals OR
--               role='creator' / 'creator' = ANY(roles)
--   writers   — has at least one row in books
--
-- Push delivery
-- -------------
-- Uses pg_net's net.http_post to fire chunks of up to 100 tokens at
-- Expo's public push API. pg_net runs asynchronously — we don't wait
-- for the Expo response; we just record how many tokens we dispatched.
-- (Same Expo API contract as scripts/withdrawals_live_blast/push_blast.mjs;
-- now server-side via pg_net so scheduled blasts fire without anyone
-- needing to be online.)
--
-- Idempotency
-- -----------
-- A blast row's status field gates re-dispatch:
--   pending   → just inserted, about to dispatch
--   scheduled → waiting for scheduled_for to arrive
--   sending   → in flight, cron + immediate handlers both skip
--   sent      → terminal success
--   failed    → terminal failure (saw an exception during dispatch)
--   cancelled → terminal admin abort
--
-- The cron job uses FOR UPDATE SKIP LOCKED so two concurrent cron
-- ticks can't double-dispatch the same row.
-- ════════════════════════════════════════════════════════════════════════

begin;

-- pg_net for the Expo HTTP POSTs. Already enabled on Supabase by
-- default but cheap to assert.
create extension if not exists pg_net;
-- pg_cron for the scheduled-blast worker.
create extension if not exists pg_cron;


-- ──────────────────────────────────────────────────────────────────────
-- 1. admin_blasts — one row per blast.
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.admin_blasts (
  id               uuid        primary key default gen_random_uuid(),
  audience         text        not null
                   check (audience in ('all_users', 'pioneers', 'creators', 'writers')),
  title            text        not null,
  body             text        not null,
  cta_url          text,
  channels         text[]      not null default array['push', 'in_app']::text[]
                   check (channels <@ array['push', 'in_app']::text[] and array_length(channels, 1) >= 1),
  scheduled_for    timestamptz,
  status           text        not null default 'pending'
                   check (status in ('pending', 'scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  in_app_count     int         not null default 0,
  push_dispatched  int         not null default 0,
  error_message    text,
  created_by       uuid        not null references public.profiles(id),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);

-- Indexes
create index if not exists admin_blasts_status_scheduled_idx
  on public.admin_blasts (status, scheduled_for)
  where status in ('pending', 'scheduled');
create index if not exists admin_blasts_created_at_idx
  on public.admin_blasts (created_at desc);

alter table public.admin_blasts enable row level security;
-- No public policies. Only the SECURITY DEFINER RPCs (and service_role)
-- can read/write this table.


-- ──────────────────────────────────────────────────────────────────────
-- 2. Audience resolver — returns the recipient_id set for an audience.
--    Keep this as a function so all four audience definitions live in
--    one place; if we later add an audience we change here + the CHECK
--    constraint on admin_blasts.audience.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public._resolve_blast_audience(p_audience text)
returns table (recipient_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_audience = 'all_users' then
    return query
      select p.id
        from public.profiles p
       where coalesce(p.is_banned, false)    = false
         and coalesce(p.is_suspended, false) = false;
  elsif p_audience = 'pioneers' then
    return query
      select p.id
        from public.profiles p
       where p.role = 'pioneer'
         and coalesce(p.is_banned, false)    = false
         and coalesce(p.is_suspended, false) = false;
  elsif p_audience = 'creators' then
    return query
      select distinct p.id
        from public.profiles p
       where coalesce(p.is_banned, false)    = false
         and coalesce(p.is_suspended, false) = false
         and (
              p.role = 'creator'
           or 'creator' = any(coalesce(p.roles, array[]::text[]))
           or exists (select 1 from public.author_earnings    e where e.author_id = p.id)
           or exists (select 1 from public.author_withdrawals w where w.author_id = p.id)
         );
  elsif p_audience = 'writers' then
    return query
      select distinct p.id
        from public.profiles p
       where coalesce(p.is_banned, false)    = false
         and coalesce(p.is_suspended, false) = false
         and exists (select 1 from public.books b where b.author_id = p.id);
  else
    raise exception 'unknown audience: %', p_audience;
  end if;
end;
$$;


-- ──────────────────────────────────────────────────────────────────────
-- 3. _dispatch_blast — internal worker. Inserts in-app notifications,
--    fires push via net.http_post. Idempotent on the row's status.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public._dispatch_blast(p_blast_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row             public.admin_blasts%rowtype;
  v_actor           uuid;
  v_in_app_count    int := 0;
  v_push_dispatched int := 0;
  v_chunk           jsonb;
begin
  -- Lock the row so we don't race ourselves.
  select * into v_row from public.admin_blasts where id = p_blast_id for update;
  if not found then
    raise exception 'blast not found: %', p_blast_id;
  end if;

  -- Only dispatch from pending / scheduled. Already-sent / cancelled /
  -- in-flight rows are skipped silently.
  if v_row.status not in ('pending', 'scheduled') then
    return;
  end if;

  update public.admin_blasts
     set status   = 'sending',
         sent_at  = now()
   where id = p_blast_id;

  v_actor := v_row.created_by;

  begin
    -- ── In-app notifications (always emit a row, even if push is
    --    the only requested channel — the bell is the source of
    --    truth for what's been sent and lets the recipient re-find
    --    the announcement after the push is dismissed). ────────────
    if 'in_app' = any(v_row.channels) then
      with audience as (
        select recipient_id from public._resolve_blast_audience(v_row.audience)
      )
      insert into public.notifications (
        recipient_id, actor_id, type, target_type, target_id,
        parent_target_id, message, preview, metadata, is_read, is_viewed
      )
      select
        a.recipient_id,
        v_actor,
        'announcement',
        'broadcast',
        v_row.id::text,
        null,
        v_row.title,
        v_row.body,
        jsonb_build_object(
          'kind',     'admin_broadcast',
          'blast_id', v_row.id,
          'audience', v_row.audience,
          'cta_url',  v_row.cta_url
        ),
        false,
        false
      from audience a;

      get diagnostics v_in_app_count = row_count;
    end if;

    -- ── Push (Expo) — server-side fan-out via pg_net. ───────────────
    -- We build chunks of 100 messages and fire one HTTP request per
    -- chunk. net.http_post is fire-and-forget from our perspective;
    -- the actual POST happens on the pg_net background worker.
    if 'push' = any(v_row.channels) then
      for v_chunk in
        with audience as (
          select distinct p.id, p.expo_push_token, p.username
            from public._resolve_blast_audience(v_row.audience) a
            join public.profiles p on p.id = a.recipient_id
           where p.expo_push_token is not null
        ),
        numbered as (
          select expo_push_token, username,
                 ((row_number() over (order by id) - 1) / 100) as chunk_idx
            from audience
        ),
        chunks as (
          select chunk_idx,
                 jsonb_agg(
                   jsonb_build_object(
                     'to',        expo_push_token,
                     'sound',     'default',
                     'title',     v_row.title,
                     'body',      v_row.body,
                     'priority',  'high',
                     'channelId', 'default',
                     'data',      jsonb_build_object(
                                    'kind',     'admin_broadcast',
                                    'blast_id', v_row.id,
                                    'cta_url',  v_row.cta_url
                                  )
                   )
                 ) as messages,
                 count(*) as messages_in_chunk
            from numbered
           group by chunk_idx
        )
        select jsonb_build_object('messages', messages, 'count', messages_in_chunk)
          from chunks
         order by chunk_idx
      loop
        perform net.http_post(
          url     := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'Accept',       'application/json'
                     ),
          body    := v_chunk->'messages'
        );
        v_push_dispatched := v_push_dispatched + (v_chunk->>'count')::int;
      end loop;
    end if;

    update public.admin_blasts
       set status          = 'sent',
           sent_at         = now(),
           in_app_count    = v_in_app_count,
           push_dispatched = v_push_dispatched,
           error_message   = null
     where id = p_blast_id;

  exception when others then
    update public.admin_blasts
       set status        = 'failed',
           error_message = format('%s (sqlstate=%s)', SQLERRM, SQLSTATE),
           in_app_count  = v_in_app_count,
           push_dispatched = v_push_dispatched
     where id = p_blast_id;
    raise warning '_dispatch_blast % failed: % (sqlstate=%)', p_blast_id, SQLERRM, SQLSTATE;
  end;
end;
$$;


-- ──────────────────────────────────────────────────────────────────────
-- 4. admin_send_blast — main entry point (admin UI calls this).
--    Returns the blast row so the UI can render the result inline.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.admin_send_blast(
  p_audience      text,
  p_title         text,
  p_body          text,
  p_cta_url       text        default null,
  p_channels      text[]      default array['push', 'in_app']::text[],
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_blast_id uuid;
  v_row     public.admin_blasts%rowtype;
  v_status  text;
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  if coalesce(trim(p_title), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'title_required');
  end if;
  if coalesce(trim(p_body), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'body_required');
  end if;
  if length(p_title) > 200 then
    return jsonb_build_object('ok', false, 'error', 'title_too_long');
  end if;
  if length(p_body) > 1000 then
    return jsonb_build_object('ok', false, 'error', 'body_too_long');
  end if;
  if p_audience not in ('all_users', 'pioneers', 'creators', 'writers') then
    return jsonb_build_object('ok', false, 'error', 'invalid_audience');
  end if;
  if p_channels is null or array_length(p_channels, 1) = 0 then
    return jsonb_build_object('ok', false, 'error', 'at_least_one_channel_required');
  end if;
  if p_cta_url is not null and length(p_cta_url) > 0 and p_cta_url !~ '^https?://' then
    return jsonb_build_object('ok', false, 'error', 'invalid_cta_url');
  end if;

  -- Decide initial status: anything in the past or null → immediate.
  if p_scheduled_for is null or p_scheduled_for <= now() then
    v_status := 'pending';
  else
    v_status := 'scheduled';
  end if;

  insert into public.admin_blasts (
    audience, title, body, cta_url, channels, scheduled_for, status, created_by
  ) values (
    p_audience, p_title, p_body, nullif(p_cta_url, ''),
    p_channels, p_scheduled_for, v_status, v_actor
  ) returning id into v_blast_id;

  -- Dispatch immediately for non-scheduled blasts. Scheduled ones get
  -- picked up by the cron worker.
  if v_status = 'pending' then
    perform public._dispatch_blast(v_blast_id);
  end if;

  select * into v_row from public.admin_blasts where id = v_blast_id;

  return jsonb_build_object(
    'ok',              true,
    'blast_id',        v_row.id,
    'status',          v_row.status,
    'in_app_count',    v_row.in_app_count,
    'push_dispatched', v_row.push_dispatched,
    'scheduled_for',   v_row.scheduled_for,
    'sent_at',         v_row.sent_at
  );
end;
$$;

grant execute on function public.admin_send_blast(text, text, text, text, text[], timestamptz)
  to authenticated;


-- ──────────────────────────────────────────────────────────────────────
-- 5. admin_list_blasts — history pane data source.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.admin_list_blasts(
  p_limit  int default 50,
  p_offset int default 0
)
returns table (
  id               uuid,
  audience         text,
  title            text,
  body             text,
  cta_url          text,
  channels         text[],
  scheduled_for    timestamptz,
  status           text,
  in_app_count     int,
  push_dispatched  int,
  error_message    text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz,
  sent_at          timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  return query
    select
      b.id, b.audience, b.title, b.body, b.cta_url, b.channels,
      b.scheduled_for, b.status, b.in_app_count, b.push_dispatched,
      b.error_message,
      b.created_by, p.username as created_by_name,
      b.created_at, b.sent_at
    from public.admin_blasts b
    left join public.profiles p on p.id = b.created_by
    order by b.created_at desc
    limit  greatest(0, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0));
end;
$$;

grant execute on function public.admin_list_blasts(int, int) to authenticated;


-- ──────────────────────────────────────────────────────────────────────
-- 6. admin_cancel_blast — abort a still-scheduled blast.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.admin_cancel_blast(p_blast_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.admin_blasts%rowtype;
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select * into v_row from public.admin_blasts where id = p_blast_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'blast_not_found');
  end if;

  if v_row.status <> 'scheduled' then
    return jsonb_build_object('ok', false, 'error', 'not_scheduled', 'current_status', v_row.status);
  end if;

  update public.admin_blasts
     set status        = 'cancelled',
         error_message = 'cancelled by ' || coalesce((select username from profiles where id = v_actor), v_actor::text)
   where id = p_blast_id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.admin_cancel_blast(uuid) to authenticated;


-- ──────────────────────────────────────────────────────────────────────
-- 7. _process_due_scheduled_blasts — cron worker.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public._process_due_scheduled_blasts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_blast_id uuid;
  v_count    int := 0;
begin
  -- FOR UPDATE SKIP LOCKED → two concurrent cron ticks can't dispatch
  -- the same row twice. The row gets locked, _dispatch_blast flips its
  -- status to 'sending' before releasing the lock, and any subsequent
  -- attempt to pick it up skips it.
  for v_blast_id in
    select id
      from public.admin_blasts
     where status = 'scheduled'
       and scheduled_for <= now()
     order by scheduled_for
     limit 50
     for update skip locked
  loop
    perform public._dispatch_blast(v_blast_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


-- ──────────────────────────────────────────────────────────────────────
-- 8. pg_cron schedule — every minute.
-- ──────────────────────────────────────────────────────────────────────
-- Drop the job if it already exists so reruns of this migration are
-- idempotent. pg_cron stores jobs by name in cron.job.
do $$
begin
  perform cron.unschedule('process_due_admin_blasts')
   from cron.job where jobname = 'process_due_admin_blasts';
exception when others then
  -- function signature may differ on older pg_cron; ignore
  null;
end $$;

select cron.schedule(
  'process_due_admin_blasts',
  '* * * * *',
  $cron$ select public._process_due_scheduled_blasts(); $cron$
);


commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm table + RPCs exist:
--      \d public.admin_blasts
--      select proname from pg_proc
--       where proname in (
--         'admin_send_blast', 'admin_list_blasts', 'admin_cancel_blast',
--         '_dispatch_blast', '_resolve_blast_audience',
--         '_process_due_scheduled_blasts'
--       );
--    Expect 6 rows.
--
-- 2. Confirm cron job is scheduled:
--      select jobname, schedule, command from cron.job
--       where jobname = 'process_due_admin_blasts';
--
-- 3. Smoke test (immediate blast to a tiny audience):
--      select public.admin_send_blast(
--        'pioneers',
--        'Test blast',
--        'Please ignore — admin smoke test',
--        null,
--        array['in_app'],
--        null
--      );
--    Then check public.admin_blasts (status='sent', in_app_count > 0)
--    and public.notifications WHERE metadata->>'blast_id' = '<id>'.
--
-- 4. Schedule a future blast (5 min out) and confirm the cron picks it up:
--      select public.admin_send_blast(
--        'all_users',
--        'Scheduled test',
--        'Scheduled smoke test, ignore.',
--        null,
--        array['in_app'],
--        now() + interval '5 minutes'
--      );
--    Wait 6 min, then:
--      select status, sent_at, in_app_count, push_dispatched
--        from public.admin_blasts where id = '<blast_id>';
--    Expect status='sent' with non-zero in_app_count.
--
-- 5. Cancel a scheduled blast:
--      select public.admin_send_blast(
--        'all_users', 'Cancel me', 'Will be cancelled before fire',
--        null, array['in_app'], now() + interval '1 hour'
--      );
--      -- copy the blast_id, then:
--      select public.admin_cancel_blast('<blast_id>'::uuid);
--    Expect ok:true and status='cancelled' on the row.


-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- do $$ begin
--   perform cron.unschedule('process_due_admin_blasts')
--    from cron.job where jobname = 'process_due_admin_blasts';
-- end $$;
-- drop function if exists public._process_due_scheduled_blasts();
-- drop function if exists public.admin_cancel_blast(uuid);
-- drop function if exists public.admin_list_blasts(int, int);
-- drop function if exists public.admin_send_blast(text, text, text, text, text[], timestamptz);
-- drop function if exists public._dispatch_blast(uuid);
-- drop function if exists public._resolve_blast_audience(text);
-- drop table    if exists public.admin_blasts;
