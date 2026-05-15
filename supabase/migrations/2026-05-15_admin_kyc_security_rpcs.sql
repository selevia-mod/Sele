-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Admin KYC list + security actions (approve / reject /
-- revoke KYC, ban / unban, plus a list RPC for the new admin UI tab).
--
-- Background
-- ----------
-- Day 2 audit + Saturday-prep work surfaced a gap: there's no admin
-- surface for managing KYCs or applying account-level security actions.
-- KYC is approved by manually flipping author_kyc.status in SQL, and
-- bans are flipped on profiles.is_banned with no audit trail. This
-- migration packages the actions as proper SECURITY DEFINER RPCs with
-- is_earnings_admin() gating + structured metadata so the next phase
-- (admin UI) can wire buttons cleanly.
--
-- What this adds
-- --------------
--   • admin_approve_kyc(user_id, notes)  — pending → approved
--   • admin_reject_kyc(user_id, reason)  — pending → rejected
--   • admin_revoke_kyc(user_id, reason)  — approved → pending
--   • admin_ban_user(user_id, reason)    — profiles.is_banned = true
--   • admin_unban_user(user_id)          — profiles.is_banned = false
--   • admin_kyc_list(status, search,
--                     limit, offset)     — list view for the admin tab
--
-- Re-uses what already exists
-- ---------------------------
--   • is_earnings_admin()                — admin gate (deployed 2026-05-14)
--   • admin_freeze_payouts / unfreeze    — freeze RPCs (deployed 2026-05-14)
--   • profiles.payouts_frozen            — freeze column (deployed)
--   • profiles.is_banned                 — ban column (deployed)
--   • author_kyc                         — KYC table (deployed Appwrite era)
--
-- Audit trail
-- -----------
-- Every action writes to public.audit_log (admin_action category) with
-- the actor uuid + the affected user uuid + structured detail. This is
-- the audit surface the moderation queue + critical alerts already
-- consume, so freeze/ban actions show up in the daily admin digest
-- (Phase 6.1) and feed into critical alerts (Phase 6.2) without any
-- extra wiring.
--
-- Notification fan-out
-- --------------------
-- Approve / reject / revoke KYC each insert a notification for the
-- creator (type='announcement', target_type='kyc') so they see "KYC
-- approved", "KYC needs more info", etc in the bell. No client-side
-- changes needed today — the existing announcement render path catches
-- target_type='kyc' the same way it catches 'withdrawal'.
-- ════════════════════════════════════════════════════════════════════════

begin;


-- ────────────────────────────────────────────────────────────────────
-- Helper: write an admin_action audit row. Mirrors the pattern used by
-- admin_freeze_payouts / admin_reject_earning so all moderation
-- actions land in the same category.
-- ────────────────────────────────────────────────────────────────────
create or replace function public._log_admin_kyc_action(
  p_actor       uuid,
  p_target      uuid,
  p_action      text,
  p_detail      jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- audit_log table exists from Phase 1.2; defensive insert in case the
  -- schema ever drifts (we don't want a logging failure to roll back a
  -- legitimate moderation action).
  begin
    insert into public.audit_log (actor_id, target_id, category, action, detail, created_at)
    values (p_actor, p_target, 'admin_action', p_action, coalesce(p_detail, '{}'::jsonb), now());
  exception when undefined_table or undefined_column then
    raise warning '_log_admin_kyc_action: audit_log not available — action % skipped logging', p_action;
  end;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Helper: emit an in-bell notification to the affected creator.
-- Same shape as withdrawal status notifications — the announcement
-- type with target_type 'kyc' so the fallback render path picks it up.
-- ────────────────────────────────────────────────────────────────────
create or replace function public._notify_kyc_status(
  p_recipient   uuid,
  p_actor       uuid,
  p_title       text,
  p_body        text,
  p_metadata    jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (
    recipient_id, actor_id, type, target_type, target_id,
    parent_target_id, message, preview, metadata, is_read, is_viewed
  ) values (
    p_recipient,
    coalesce(p_actor, p_recipient),
    'announcement',
    'kyc',
    p_recipient,                            -- target the creator's own profile (uuid)
    null,
    p_title,
    p_body,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('kind', 'kyc_status_change'),
    false,
    false
  )
  on conflict on constraint notifications_dedup_uniq do nothing;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 1. admin_approve_kyc — flip pending/rejected → approved.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.admin_approve_kyc(
  p_user_id  uuid,
  p_notes    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_prev_status text;
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select kyc_status into v_prev_status
    from public.author_kyc
   where author_id = p_user_id
   for update;

  if v_prev_status is null then
    raise exception 'kyc_not_found' using errcode = 'P0002';
  end if;

  if v_prev_status = 'approved' then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_approved');
  end if;

  update public.author_kyc
     set kyc_status  = 'approved',
         approved_at = now(),
         approved_by = v_actor,
         reviewed_at = now()
   where author_id = p_user_id;

  perform public._log_admin_kyc_action(
    v_actor, p_user_id, 'admin_approve_kyc',
    jsonb_build_object('previous_status', v_prev_status, 'notes', p_notes)
  );

  perform public._notify_kyc_status(
    p_user_id, v_actor,
    'KYC approved',
    'Your identity verification has been approved. You can now request withdrawals.',
    jsonb_build_object('previous_status', v_prev_status, 'new_status', 'approved')
  );

  return jsonb_build_object('ok', true, 'previous_status', v_prev_status);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 2. admin_reject_kyc — flip pending → rejected with a reason.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.admin_reject_kyc(
  p_user_id  uuid,
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_prev_status text;
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select kyc_status into v_prev_status
    from public.author_kyc
   where author_id = p_user_id
   for update;

  if v_prev_status is null then
    raise exception 'kyc_not_found' using errcode = 'P0002';
  end if;

  if v_prev_status = 'rejected' then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_rejected');
  end if;

  update public.author_kyc
     set kyc_status        = 'rejected',
         rejection_reason  = p_reason,
         reviewed_at       = now(),
         approved_at       = null,
         approved_by       = null
   where author_id = p_user_id;

  perform public._log_admin_kyc_action(
    v_actor, p_user_id, 'admin_reject_kyc',
    jsonb_build_object('previous_status', v_prev_status, 'reason', p_reason)
  );

  perform public._notify_kyc_status(
    p_user_id, v_actor,
    'KYC needs more info',
    format('Your identity verification was not approved. Reason: %s', p_reason),
    jsonb_build_object('previous_status', v_prev_status, 'new_status', 'rejected', 'reason', p_reason)
  );

  return jsonb_build_object('ok', true, 'previous_status', v_prev_status);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 3. admin_revoke_kyc — undo an approval (approved → pending). Useful
--    when fraud signals surface AFTER the creator was approved.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.admin_revoke_kyc(
  p_user_id  uuid,
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_prev_status text;
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select kyc_status into v_prev_status
    from public.author_kyc
   where author_id = p_user_id
   for update;

  if v_prev_status is null then
    raise exception 'kyc_not_found' using errcode = 'P0002';
  end if;

  if v_prev_status <> 'approved' then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'not_currently_approved');
  end if;

  update public.author_kyc
     set kyc_status        = 'pending',
         rejection_reason  = p_reason,
         approved_at       = null,
         approved_by       = null,
         reviewed_at       = now()
   where author_id = p_user_id;

  perform public._log_admin_kyc_action(
    v_actor, p_user_id, 'admin_revoke_kyc',
    jsonb_build_object('previous_status', v_prev_status, 'reason', p_reason)
  );

  perform public._notify_kyc_status(
    p_user_id, v_actor,
    'KYC under review',
    format('Your identity verification is being re-reviewed. Reason: %s', p_reason),
    jsonb_build_object('previous_status', v_prev_status, 'new_status', 'pending', 'reason', p_reason)
  );

  return jsonb_build_object('ok', true, 'previous_status', v_prev_status);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 4. admin_ban_user — set profiles.is_banned = true, optionally with a
--    reason. Bans the account from all writes (RLS uses is_banned in
--    several policies). Does NOT freeze payouts automatically — call
--    admin_freeze_payouts separately if you also want to block withdraws
--    (typical for fraud bans).
-- ────────────────────────────────────────────────────────────────────
create or replace function public.admin_ban_user(
  p_user_id  uuid,
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_was_banned  boolean;
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select is_banned into v_was_banned
    from public.profiles
   where id = p_user_id
   for update;

  if v_was_banned is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if v_was_banned then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_banned');
  end if;

  update public.profiles
     set is_banned        = true,
         banned_at        = now(),
         banned_reason    = p_reason,
         banned_by        = v_actor
   where id = p_user_id;

  perform public._log_admin_kyc_action(
    v_actor, p_user_id, 'admin_ban_user',
    jsonb_build_object('reason', p_reason)
  );

  return jsonb_build_object('ok', true);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 5. admin_unban_user — clear the ban.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.admin_unban_user(
  p_user_id  uuid,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_was_banned  boolean;
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select is_banned into v_was_banned
    from public.profiles
   where id = p_user_id
   for update;

  if v_was_banned is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if not v_was_banned then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'not_banned');
  end if;

  update public.profiles
     set is_banned        = false,
         banned_at        = null,
         banned_reason    = null,
         banned_by        = null
   where id = p_user_id;

  perform public._log_admin_kyc_action(
    v_actor, p_user_id, 'admin_unban_user',
    jsonb_build_object('reason', p_reason)
  );

  return jsonb_build_object('ok', true);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 6. admin_kyc_list — paginated view feeding the admin KYC tab.
--    Filters: status (approved | pending | rejected | all), search by
--    username/full_name. Returns one row per author_kyc record with
--    profile info + freeze/ban flags joined in.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.admin_kyc_list(
  p_status   text   default 'approved',
  p_search   text   default null,
  p_limit    int    default 50,
  p_offset   int    default 0
)
returns table (
  author_id        uuid,
  username         text,
  display_name     text,
  full_name        text,
  email            text,
  kyc_status       text,
  approved_at      timestamptz,
  approved_by      uuid,
  rejection_reason text,
  payouts_frozen   boolean,
  payouts_frozen_at timestamptz,
  payouts_frozen_reason text,
  is_banned        boolean,
  banned_at        timestamptz,
  banned_reason    text,
  total_count      bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_q     text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  return query
  with filtered as (
    select
      k.author_id,
      p.username,
      p.display_name,
      k.full_name,
      u.email::text                 as email,
      k.kyc_status,
      k.approved_at,
      k.approved_by,
      k.rejection_reason,
      coalesce(p.payouts_frozen, false)        as payouts_frozen,
      p.payouts_frozen_at,
      p.payouts_frozen_reason,
      coalesce(p.is_banned, false)             as is_banned,
      p.banned_at,
      p.banned_reason
    from public.author_kyc k
    join public.profiles p on p.id = k.author_id
    left join auth.users  u on u.id = k.author_id
    where (p_status is null or p_status = 'all' or k.kyc_status = p_status)
      and (v_q is null
           or p.username    ilike '%' || v_q || '%'
           or p.display_name ilike '%' || v_q || '%'
           or k.full_name   ilike '%' || v_q || '%'
           or u.email::text ilike '%' || v_q || '%')
  ),
  counted as (
    select *, count(*) over () as total_count from filtered
  )
  select
    c.author_id, c.username, c.display_name, c.full_name, c.email,
    c.kyc_status, c.approved_at, c.approved_by, c.rejection_reason,
    c.payouts_frozen, c.payouts_frozen_at, c.payouts_frozen_reason,
    c.is_banned, c.banned_at, c.banned_reason,
    c.total_count
  from counted c
  order by c.approved_at desc nulls last, c.username
  limit  greatest(0, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Grants — Supabase service role + authenticated callers. The
-- is_earnings_admin() gate inside each function is the real
-- enforcement; the GRANT just lets the function be called. Without
-- this, the web client would get 'permission denied for function'
-- before reaching our internal admin check.
-- ────────────────────────────────────────────────────────────────────
grant execute on function public.admin_approve_kyc(uuid, text)        to authenticated, service_role;
grant execute on function public.admin_reject_kyc(uuid, text)         to authenticated, service_role;
grant execute on function public.admin_revoke_kyc(uuid, text)         to authenticated, service_role;
grant execute on function public.admin_ban_user(uuid, text)           to authenticated, service_role;
grant execute on function public.admin_unban_user(uuid, text)         to authenticated, service_role;
grant execute on function public.admin_kyc_list(text, text, int, int) to authenticated, service_role;


commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
-- 1. Confirm all 6 functions exist:
--    select proname from pg_proc
--     where proname in ('admin_approve_kyc','admin_reject_kyc','admin_revoke_kyc',
--                       'admin_ban_user','admin_unban_user','admin_kyc_list')
--     order by proname;
--    Should return 6 rows.
--
-- 2. Smoke test the list (run as admin):
--    select author_id, username, kyc_status, payouts_frozen, is_banned, total_count
--      from public.admin_kyc_list('approved', null, 10, 0);
--
-- 3. Optional smoke test for ban/freeze on a throwaway user:
--    select admin_ban_user('<uuid>'::uuid, 'TEST — please ignore');
--    select id, is_banned, banned_at, banned_reason from public.profiles where id = '<uuid>';
--    select admin_unban_user('<uuid>'::uuid, 'TEST cleanup');
--
-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- drop function if exists public.admin_approve_kyc(uuid, text);
-- drop function if exists public.admin_reject_kyc(uuid, text);
-- drop function if exists public.admin_revoke_kyc(uuid, text);
-- drop function if exists public.admin_ban_user(uuid, text);
-- drop function if exists public.admin_unban_user(uuid, text);
-- drop function if exists public.admin_kyc_list(text, text, int, int);
-- drop function if exists public._log_admin_kyc_action(uuid, uuid, text, jsonb);
-- drop function if exists public._notify_kyc_status(uuid, uuid, text, text, jsonb);
