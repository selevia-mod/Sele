-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Fix column-name mismatch in admin KYC RPCs
--
-- Background
-- ----------
-- The earlier 2026-05-15_admin_kyc_security_rpcs.sql + role hierarchy
-- migrations referenced author_kyc.author_id and author_kyc.kyc_status,
-- but the actual column names in the deployed schema are:
--   • user_id   (not author_id)
--   • status    (not kyc_status)
--   • reviewed_at (already exists)
--   • approved_at / approved_by — not guaranteed to exist
--
-- The functions compiled fine because PG defers column-reference
-- validation until the function actually runs. As soon as Charles
-- opened the admin → Payouts → KYC review tab, the RPC raised:
--   ERROR: column k.author_id does not exist
--
-- This fix:
--   1. Adds approved_at + approved_by columns to author_kyc if missing
--      (idempotent — safe to run on a schema that already has them).
--   2. Re-creates all four KYC RPCs with the correct column names.
--   3. Re-creates admin_kyc_list with the right joins.
-- ════════════════════════════════════════════════════════════════════════

begin;


-- ────────────────────────────────────────────────────────────────────
-- 1. Add approved_at + approved_by columns if they don't already exist.
-- ────────────────────────────────────────────────────────────────────
alter table public.author_kyc
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id);


-- ────────────────────────────────────────────────────────────────────
-- 2. admin_approve_kyc — flip pending/rejected → approved.
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

  select status into v_prev_status
    from public.author_kyc
   where user_id = p_user_id
   for update;

  if v_prev_status is null then
    raise exception 'kyc_not_found' using errcode = 'P0002';
  end if;

  if v_prev_status = 'approved' then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_approved');
  end if;

  update public.author_kyc
     set status      = 'approved',
         approved_at = now(),
         approved_by = v_actor,
         reviewed_at = now()
   where user_id = p_user_id;

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
-- 3. admin_reject_kyc — flip pending → rejected with a reason.
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

  select status into v_prev_status
    from public.author_kyc
   where user_id = p_user_id
   for update;

  if v_prev_status is null then
    raise exception 'kyc_not_found' using errcode = 'P0002';
  end if;

  if v_prev_status = 'rejected' then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_rejected');
  end if;

  update public.author_kyc
     set status            = 'rejected',
         rejection_reason  = p_reason,
         reviewed_at       = now(),
         approved_at       = null,
         approved_by       = null
   where user_id = p_user_id;

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
-- 4. admin_revoke_kyc — undo an approval (approved → pending).
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

  select status into v_prev_status
    from public.author_kyc
   where user_id = p_user_id
   for update;

  if v_prev_status is null then
    raise exception 'kyc_not_found' using errcode = 'P0002';
  end if;

  if v_prev_status <> 'approved' then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'not_currently_approved');
  end if;

  update public.author_kyc
     set status            = 'pending',
         rejection_reason  = p_reason,
         approved_at       = null,
         approved_by       = null,
         reviewed_at       = now()
   where user_id = p_user_id;

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
-- 5. admin_kyc_list — recreated with the correct column names.
--    The public-facing return columns keep the friendly aliases
--    (`author_id`, `kyc_status`) so the web client doesn't need
--    another rewrite — only the internal SELECT needs to use the
--    real column names.
-- ────────────────────────────────────────────────────────────────────
drop function if exists public.admin_kyc_list(text, text, int, int);

create function public.admin_kyc_list(
  p_status   text   default 'approved',
  p_search   text   default null,
  p_limit    int    default 50,
  p_offset   int    default 0
)
returns table (
  author_id              uuid,
  username               text,
  display_name           text,
  full_name              text,
  email                  text,
  user_role              text,
  kyc_status             text,
  approved_at            timestamptz,
  approved_by            uuid,
  rejection_reason       text,
  payouts_frozen         boolean,
  payouts_frozen_at      timestamptz,
  payouts_frozen_reason  text,
  is_banned              boolean,
  banned_at              timestamptz,
  banned_reason          text,
  total_count            bigint,
  viewer_is_super_admin  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid    := auth.uid();
  v_q        text    := nullif(trim(coalesce(p_search, '')), '');
  v_is_super boolean := public.is_super_admin(v_actor);
begin
  if not public.is_earnings_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  return query
  with filtered as (
    select
      k.user_id                              as author_id,         -- ← was k.author_id
      p.username,
      p.display_name,
      k.full_name,
      u.email::text                          as email,
      coalesce(p.role, 'user')               as user_role,
      k.status                               as kyc_status,        -- ← was k.kyc_status
      k.approved_at,
      k.approved_by,
      k.rejection_reason,
      coalesce(p.payouts_frozen, false)      as payouts_frozen,
      p.payouts_frozen_at,
      p.payouts_frozen_reason,
      coalesce(p.is_banned, false)           as is_banned,
      p.banned_at,
      p.banned_reason
    from public.author_kyc k
    join public.profiles p on p.id = k.user_id                     -- ← was k.author_id
    left join auth.users  u on u.id = k.user_id                    -- ← was k.author_id
    where (p_status is null or p_status = 'all' or k.status = p_status)
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
    c.user_role,
    c.kyc_status, c.approved_at, c.approved_by, c.rejection_reason,
    c.payouts_frozen, c.payouts_frozen_at, c.payouts_frozen_reason,
    c.is_banned, c.banned_at, c.banned_reason,
    c.total_count,
    v_is_super                              as viewer_is_super_admin
  from counted c
  order by c.approved_at desc nulls last, c.username
  limit  greatest(0, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

grant execute on function public.admin_kyc_list(text, text, int, int) to authenticated, service_role;


commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
-- 1. Confirm the new columns exist on author_kyc:
--      select column_name from information_schema.columns
--       where table_schema = 'public' and table_name = 'author_kyc'
--         and column_name in ('user_id', 'status', 'approved_at', 'approved_by');
--      Expect 4 rows.
--
-- 2. Smoke test admin_kyc_list (must be called with an authenticated
--    JWT, OR set request.jwt.claim.sub first):
--      select set_config('request.jwt.claim.sub',
--        (select id::text from auth.users where email = 'juncalague26@gmail.com'),
--        true);
--      select author_id, username, kyc_status, payouts_frozen, total_count
--        from public.admin_kyc_list('approved', null, 10, 0);
--      Expect Sammy's row.
--
-- 3. Run the same with status='pending' to see actual pending submissions.
