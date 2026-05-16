-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-17 — request_author_withdrawal: only block on pending, not approved
--
-- ─── IMPORTANT: which overload this patches ────────────────────────────
-- There are TWO function signatures named request_author_withdrawal in
-- this database, both still live:
--
--   A. (p_amount int, p_currency text, p_actor_id uuid)
--      Created in 2026-05-09_unlock_rpcs_canonicalize_user_id.sql.
--      Legacy signature — NO LONGER CALLED by any client (web or
--      mobile). Error code for the blocked-by-existing case:
--      'pending_request_exists'.
--
--   B. (p_amount_php_minor int, p_payout_method text,
--       p_payout_details jsonb, p_actor_id uuid)
--      Created in 2026-05-14_earnings_moderation_balance_recompute.sql.
--      CANONICAL signature used by both web (js/earnings.js:1895) and
--      mobile (lib/earningsService.js). Error code for the blocked-by-
--      existing case: 'withdrawal_in_progress'.
--
-- THIS migration patches overload **B**, the one actually called by
-- the app. My first attempt patched A, which is why Charles kept
-- seeing the block message even after the migration ran — Postgres
-- happily resolves the call to overload B and ignores A.
-- ───────────────────────────────────────────────────────────────────────
--
-- Background
-- ----------
-- Previous gate (2026-05-14, line 252):
--   where author_id = v_user_id and status in ('pending', 'approved')
--
-- New gate (this migration):
--   where author_id = v_user_id and status = 'pending'
--
-- Per Charles's product model: when admin/moderator approves a payout
-- request, the user is immediately free to queue a new request. The
-- admin still has to send money externally (manual GCash/bank) and
-- click "Mark paid" to flip status from 'approved' to 'paid', but
-- that's an admin housekeeping step — it shouldn't gate the creator.
--
-- Side benefit: every existing 'approved'-but-not-paid row stops
-- blocking its creator the instant this commits. Around two dozen
-- users with stuck approved rows from March / pre-launch testing
-- become able to request again without any data backfill.
--
-- The 'pending' gate stays — a user with a request still awaiting
-- admin review correctly cannot queue another one.
--
-- Surface area
-- ------------
-- Only the existing-request check changes (one line). Everything else
-- — canonicalize, min-amount check, payout-method validation, KYC
-- gate, payouts_frozen gate, balance gate, pioneer-exemption math,
-- fee computation, INSERT, earmark loop, return shape — is byte-
-- identical to the 2026-05-14 version. The function is re-emitted in
-- full so the new definition replaces the old one cleanly (CREATE
-- OR REPLACE preserves the existing signature, so overload A is
-- untouched and stays alongside as dead-but-harmless code).
--
-- Rollback
-- --------
-- Re-apply 2026-05-14_earnings_moderation_balance_recompute.sql.
-- ════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.request_author_withdrawal(
  p_amount_php_minor integer,
  p_payout_method    text,
  p_payout_details   jsonb,
  p_actor_id         uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_auth_uid         uuid := auth.uid();
  v_user_id          uuid;
  v_min_php_whole    int := coalesce(public.get_config_int('WITHDRAWAL_MINIMUM_AMOUNT'), 100);
  v_min_php_minor    int := v_min_php_whole * 100;
  v_kyc_req          int := coalesce(public.get_config_int('author_payout_kyc_required'), 1);
  v_balance          jsonb;
  v_available_minor  int;
  v_kyc_status       text;
  v_payouts_frozen   boolean;
  v_freeze_reason    text;
  v_id               uuid;
  v_remaining        int;
  v_earning          record;
  v_earning_amount   int;

  v_role             text;
  v_pioneer_at       timestamptz;
  v_exempt_days      int := coalesce(public.get_config_int('pioneer_exemption_days'), 365);
  v_is_pioneer_exempt boolean := false;

  v_platform_pct_x100 int;
  v_transfer_pct_x100 int;
  v_fee_minor         int := 0;
  v_net_minor         int;
begin
  -- ── CANONICALIZE actor id ─────────────────────────────────────────────
  if v_auth_uid is not null then
    select id into v_user_id from public.profiles
    where auth_user_id = v_auth_uid or id = v_auth_uid
    order by case when auth_user_id = v_auth_uid then 0 else 1 end
    limit 1;
  end if;
  if v_user_id is null then v_user_id := p_actor_id; end if;

  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_amount_php_minor is null or p_amount_php_minor < v_min_php_minor then
    return jsonb_build_object(
      'ok', false, 'error', 'below_minimum',
      'minimum_php_minor', v_min_php_minor
    );
  end if;
  if p_payout_method not in ('gcash', 'maya', 'bank', 'other') then
    return jsonb_build_object('ok', false, 'error', 'invalid_payout_method');
  end if;
  if p_payout_details is null or jsonb_typeof(p_payout_details) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'missing_payout_details');
  end if;

  -- KYC gate (unchanged).
  if v_kyc_req = 1 then
    select status into v_kyc_status from public.author_kyc where user_id = v_user_id;
    if v_kyc_status is null then
      return jsonb_build_object('ok', false, 'error', 'kyc_not_submitted');
    elsif v_kyc_status <> 'approved' then
      return jsonb_build_object('ok', false, 'error', 'kyc_not_approved', 'kyc_status', v_kyc_status);
    end if;
  end if;

  -- payouts_frozen gate (unchanged).
  select payouts_frozen, payouts_frozen_reason
    into v_payouts_frozen, v_freeze_reason
    from public.profiles where id = v_user_id;

  if coalesce(v_payouts_frozen, false) = true then
    return jsonb_build_object(
      'ok', false, 'error', 'payouts_frozen',
      'reason', coalesce(v_freeze_reason, 'Payouts are temporarily on hold pending review.')
    );
  end if;

  -- Available-balance gate (unchanged).
  v_balance         := public.author_balance_for(v_user_id);
  v_available_minor := (v_balance->>'available_php_minor')::int;
  if v_available_minor < p_amount_php_minor then
    return jsonb_build_object(
      'ok', false, 'error', 'insufficient_available',
      'available_php_minor', v_available_minor,
      'requested_php_minor', p_amount_php_minor
    );
  end if;

  -- ─── THE ONLY CHANGE vs. the 2026-05-14 version ──────────────────────
  -- Previously: status in ('pending', 'approved')
  -- Now:        status = 'pending'
  --
  -- Rationale: an `approved` row is in the admin's hands (waiting for
  -- the manual GCash/bank send + "Mark paid" click). The creator
  -- should be free to queue another request against any new earnings
  -- they've accumulated. The earmark on author_earnings.withdrawal_id
  -- still prevents the same earnings being double-spent into two
  -- different withdrawal rows.
  -- ─────────────────────────────────────────────────────────────────────
  if exists (
    select 1 from public.author_withdrawals
    where author_id = v_user_id and status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'error', 'withdrawal_in_progress');
  end if;

  -- Pioneer exemption logic (unchanged).
  select role, pioneer_at into v_role, v_pioneer_at
    from public.profiles
   where id = v_user_id;

  if v_role = 'pioneer' and v_pioneer_at is not null
     and (v_pioneer_at + (v_exempt_days || ' days')::interval) >= now()
  then
    v_is_pioneer_exempt := true;
  end if;

  if v_is_pioneer_exempt then
    v_fee_minor := 0;
  else
    select coalesce((select round(value::numeric * 100)::int
                      from public.app_config
                     where key = 'PLATFORM_COST'), 20)
      into v_platform_pct_x100;
    select coalesce((select round(value::numeric * 100)::int
                      from public.app_config
                     where key = 'TRANSFER_FEE'), 2)
      into v_transfer_pct_x100;
    v_fee_minor := (p_amount_php_minor * (v_platform_pct_x100 + v_transfer_pct_x100)) / 100;
  end if;

  v_net_minor := p_amount_php_minor - v_fee_minor;
  if v_net_minor <= 0 then
    return jsonb_build_object('ok', false, 'error', 'fees_exceed_amount');
  end if;

  insert into public.author_withdrawals
    (author_id, amount_coins, amount_php_minor, fee_php_minor, net_php_minor,
     is_pioneer_exempt, payout_method, payout_details, status)
  values
    (v_user_id, 0,
     p_amount_php_minor,
     v_fee_minor,
     v_net_minor,
     v_is_pioneer_exempt,
     p_payout_method, p_payout_details, 'pending')
  returning id into v_id;

  -- Earmark earnings against this withdrawal. Unchanged from
  -- 2026-05-14 — only pulls rows in terminal "money is real" states
  -- (verified, adjusted, or legacy available).
  v_remaining := p_amount_php_minor;
  for v_earning in
    select id, net_php_minor, adjusted_net_php_minor, status
      from public.author_earnings
     where author_id = v_user_id
       and status in ('verified', 'adjusted', 'available')
       and withdrawal_id is null
     order by created_at asc
  loop
    exit when v_remaining <= 0;
    v_earning_amount := case
      when v_earning.status = 'adjusted'
        then coalesce(v_earning.adjusted_net_php_minor, v_earning.net_php_minor)
      else v_earning.net_php_minor
    end;
    if v_earning_amount <= v_remaining then
      update public.author_earnings
         set status = case when status = 'adjusted' then 'adjusted' else 'verified' end,
             withdrawal_id = v_id
       where id = v_earning.id;
      v_remaining := v_remaining - v_earning_amount;
    else
      exit;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'withdrawal_id', v_id,
    'amount_php_minor', p_amount_php_minor,
    'fee_php_minor', v_fee_minor,
    'net_php_minor', v_net_minor,
    'is_pioneer_exempt', v_is_pioneer_exempt
  );
end;
$function$;

-- Reload PostgREST schema cache so the new definition lands without
-- waiting for the periodic refresh.
notify pgrst, 'reload schema';

commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after the migration commits)
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm the new function body has the corrected gate:
--      select pg_get_functiondef(p.oid)
--        from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and p.proname = 'request_author_withdrawal'
--         and pg_get_function_identity_arguments(p.oid)
--             like '%p_amount_php_minor%';
--    Search the output for `status = 'pending'` (singular). The old
--    `status in ('pending', 'approved')` should be GONE for this
--    overload.
--
-- 2. Smoke-test: pick a user with a stuck `approved` row (e.g. Sammy,
--    Dear Jen, or any of the ~20 from March). They should now be able
--    to request a new withdrawal via the Earnings tab without seeing
--    the "you already have a pending or approved request" toast.
--
-- 3. Negative test: pick a user with an actual `pending` row (e.g.
--    Anne Writes or Ilocanang_Author from May 1). Attempting to
--    request a new withdrawal should still error with
--    `withdrawal_in_progress` — that gate stays in place.
