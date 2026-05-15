-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Admin / moderator role hierarchy
--
-- Background
-- ----------
-- Both 'admin' and 'moderator' roles pass is_earnings_admin() and can
-- use the admin tools (KYC list, freeze/ban, earnings moderation, etc).
-- That's the right behaviour — moderators do day-to-day moderation work.
-- BUT we don't want moderators handing out the moderator role to their
-- friends, or — worse — promoting themselves to admin. Role assignment
-- should be admin-only.
--
-- Charles's rule (2026-05-15):
--   "Admins and moderators should both have access to admin page.
--    However, moderators cannot assign moderator roles to other users,
--    only admins can do that."
--
-- This migration adds:
--   • is_super_admin(uid)        — true only for role='admin' (not moderator)
--   • admin_set_user_role(...)   — admin-only RPC; self-demotion guard;
--                                  audit_log row on every change
--   • admin_kyc_list (replaced)  — adds user_role + viewer_is_super_admin
--                                  to the returned shape so the UI can
--                                  render a Role column + conditionally
--                                  show the Change Role button
--
-- The Web UI hides role-management controls from moderators using the
-- viewer_is_super_admin flag. Server-side, admin_set_user_role re-checks
-- is_super_admin() so a moderator who pokes at the DOM still gets 42501.
-- ════════════════════════════════════════════════════════════════════════

begin;


-- ────────────────────────────────────────────────────────────────────
-- 1. is_super_admin — the strict admin check.
--    is_earnings_admin returns true for both 'admin' and 'moderator';
--    this one returns true ONLY for 'admin'. Used to gate role
--    assignment, future destructive ops (e.g. data export, billing
--    actions).
-- ────────────────────────────────────────────────────────────────────
create or replace function public.is_super_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = uid
      and role = 'admin'
      and coalesce(is_banned, false) = false
  );
$$;

grant execute on function public.is_super_admin(uuid) to authenticated, service_role;


-- ────────────────────────────────────────────────────────────────────
-- 2. admin_set_user_role — change a user's role.
--    Only super-admins can call. Self-demotion is blocked (so the
--    last admin can't lock themselves out by accident). Every change
--    is audited.
--
--    Allowed roles: 'user', 'moderator', 'admin'. Anything else is
--    rejected with 22023.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.admin_set_user_role(
  p_user_id  uuid,
  p_role     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_prev_role   text;
  v_normalized  text := lower(trim(coalesce(p_role, '')));
begin
  -- Permission gate — only admins (not moderators) may change roles.
  if not public.is_super_admin(v_actor) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  -- Validate the new role.
  if v_normalized not in ('user', 'moderator', 'admin') then
    raise exception 'invalid_role'
      using errcode = '22023',
            detail  = 'role must be one of: user, moderator, admin';
  end if;

  -- Self-demotion guard. Admins can promote themselves (no-op anyway)
  -- but cannot demote themselves out of the admin role. Prevents
  -- "I locked the only admin out by accident" footguns. To downgrade
  -- yourself, ask another admin.
  if v_actor = p_user_id and v_normalized <> 'admin' then
    raise exception 'cannot_self_demote'
      using errcode = 'P0001',
            detail  = 'admins cannot demote themselves; ask another admin';
  end if;

  select role into v_prev_role
    from public.profiles
   where id = p_user_id
   for update;

  if v_prev_role is null then
    -- The id existed nowhere in profiles. Treat as user_not_found.
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  if coalesce(v_prev_role, 'user') = v_normalized then
    return jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_' || v_normalized);
  end if;

  update public.profiles
     set role = v_normalized
   where id = p_user_id;

  -- Reuse the helper added by 2026-05-15_admin_kyc_security_rpcs.sql.
  -- Defensive fallback for installs that haven't run that migration.
  begin
    perform public._log_admin_kyc_action(
      v_actor, p_user_id, 'admin_set_user_role',
      jsonb_build_object('previous_role', v_prev_role, 'new_role', v_normalized)
    );
  exception when undefined_function then
    -- Inline a minimal audit insert if the helper doesn't exist.
    insert into public.audit_log (actor_id, target_id, category, action, detail, created_at)
    values (v_actor, p_user_id, 'admin_action', 'admin_set_user_role',
            jsonb_build_object('previous_role', v_prev_role, 'new_role', v_normalized),
            now());
  end;

  return jsonb_build_object(
    'ok',            true,
    'previous_role', v_prev_role,
    'new_role',      v_normalized
  );
end;
$$;

grant execute on function public.admin_set_user_role(uuid, text) to authenticated, service_role;


-- ────────────────────────────────────────────────────────────────────
-- 3. admin_kyc_list — recreated with user_role + viewer_is_super_admin
--    columns so the UI can render the Role column AND conditionally
--    show role-change controls.
--
--    DROP + CREATE because PG doesn't allow altering a function's
--    return type. The web UI needs to re-deploy alongside this
--    migration; older bundles are tolerant — the new columns appear
--    as ignored fields.
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
      k.author_id,
      p.username,
      p.display_name,
      k.full_name,
      u.email::text                          as email,
      coalesce(p.role, 'user')               as user_role,
      k.kyc_status,
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
-- 1. Confirm the new function shape (should show 18 columns including
--    user_role + viewer_is_super_admin):
--      select pg_get_function_arguments(p.oid)  as args,
--             pg_get_function_result(p.oid)     as returns
--        from pg_proc p
--       where p.proname = 'admin_kyc_list'
--         and p.pronamespace = 'public'::regnamespace;
--
-- 2. Confirm is_super_admin returns true for you and false for any
--    moderator-only account:
--      select id, username, role,
--             public.is_super_admin(id) as is_super
--        from public.profiles
--       where role in ('admin', 'moderator');
--
-- 3. Smoke test the role assignment (replace UUIDs):
--      -- as admin: this should succeed
--      select public.admin_set_user_role('<some-test-user-uuid>', 'moderator');
--      select role from public.profiles where id = '<some-test-user-uuid>';
--      -- back to user
--      select public.admin_set_user_role('<some-test-user-uuid>', 'user');
--
-- 4. Self-demotion guard test (run as yourself):
--      select public.admin_set_user_role(auth.uid(), 'user');
--      -- expected: ERROR P0001 cannot_self_demote
--
-- 5. Moderator gate test (impersonate a moderator JWT, or run as a
--    moderator-role profile):
--      select public.admin_set_user_role('<some-uuid>', 'moderator');
--      -- expected: ERROR 42501 permission_denied


-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- drop function if exists public.admin_set_user_role(uuid, text);
-- drop function if exists public.is_super_admin(uuid);
-- -- Restore the previous admin_kyc_list shape (without user_role +
-- -- viewer_is_super_admin) by re-running 2026-05-15_admin_kyc_security_rpcs.sql.
