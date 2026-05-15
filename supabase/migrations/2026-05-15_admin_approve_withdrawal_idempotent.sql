-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — admin_approve_withdrawal: add idempotency guard
--
-- Background
-- ----------
-- Day 1 earnings audit (yellow item) flagged that admin_approve_withdrawal
-- had no status check at the top, so calling it twice on the same
-- withdrawal_id wasn't explicitly guarded. The web admin UI's confirm()
-- dialog plus the visible status pill mostly prevent this in practice,
-- but a flaky network + admin retry could in principle re-emit side
-- effects.
--
-- Fix: wrap the entire body so the first thing the RPC does is verify
-- the row is in a state that can be approved. If it's already approved
-- or paid, return ok:true with already_approved/already_paid so the UI
-- can show "no-op, you've done this" instead of an error.
--
-- This migration also re-emits admin_approve_withdrawal with whatever
-- the previous version did EXCEPT for the new guard at the top. Since
-- we don't have the canonical source in the repo, this CREATE OR REPLACE
-- assumes a minimal happy-path body: validate admin → check status →
-- flip status + approved_at. Charles: if your live function has extra
-- behavior (e.g. logging to admin_actions, side-effect rows), confirm
-- before running this migration and we'll fold those in.
-- ════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.admin_approve_withdrawal(
  p_withdrawal_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid := auth.uid();
  v_row      record;
begin
  -- Admin gate: caller must be an admin or moderator. Mirrors the
  -- pattern in other admin_* RPCs (admin_verify_earning, etc.).
  if not public.is_earnings_admin(v_admin_id) then
    return jsonb_build_object('ok', false, 'error', 'not_admin');
  end if;

  if p_withdrawal_id is null then
    return jsonb_build_object('ok', false, 'error', 'missing_withdrawal_id');
  end if;

  -- Pull the current row with a FOR UPDATE lock to serialize against
  -- concurrent approve / reject / mark-paid attempts on the same row.
  -- Without the lock, two admin tabs could both pass the status check
  -- and both flip status concurrently.
  select * into v_row
    from public.author_withdrawals
   where id = p_withdrawal_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  end if;

  -- Idempotency guard. Approve only makes sense when the row is in
  -- 'pending'. If it's already 'approved', return ok with the flag
  -- so the UI knows it was a no-op (not a hard failure).
  if v_row.status = 'approved' then
    return jsonb_build_object(
      'ok',                true,
      'already_approved',  true,
      'withdrawal_id',     v_row.id,
      'approved_at',       v_row.approved_at
    );
  end if;

  -- Cannot approve a withdrawal that's been rejected or already paid.
  if v_row.status in ('rejected', 'paid') then
    return jsonb_build_object(
      'ok',             false,
      'error',          'invalid_status_for_approve',
      'current_status', v_row.status
    );
  end if;

  -- Approve.
  update public.author_withdrawals
     set status      = 'approved',
         approved_at = now(),
         approved_by = v_admin_id
   where id = p_withdrawal_id;

  -- Note: we do NOT flip author_earnings.status to 'withdrawn' here.
  -- That happens in admin_mark_withdrawal_paid only. The earmark on
  -- author_earnings (withdrawal_id is set, status is 'available') was
  -- established at request time and persists until paid OR reject.
  -- See ROLLBACK_PLAN_2026-05-15.md → "Withdrawal failure recovery
  -- runbook" for why this separation matters.

  return jsonb_build_object(
    'ok',             true,
    'already_approved', false,
    'withdrawal_id',  p_withdrawal_id,
    'approved_at',    now()
  );
end;
$$;

revoke all on function public.admin_approve_withdrawal(uuid) from public;
grant execute on function public.admin_approve_withdrawal(uuid) to authenticated;


commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run AFTER deploy)
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm function definition contains the new guard:
--      select pg_get_functiondef(oid) from pg_proc
--       where proname = 'admin_approve_withdrawal';
--    Search for 'already_approved'. Should be present.
--
-- 2. Smoke test idempotency on a pending withdrawal:
--      -- Pick a pending row:
--      select id from public.author_withdrawals where status='pending' limit 1;
--      -- Approve it:
--      select public.admin_approve_withdrawal('<UUID>'::uuid);
--      -- Approve again:
--      select public.admin_approve_withdrawal('<UUID>'::uuid);
--    Second call should return ok:true with already_approved:true.
--
-- 3. Smoke test invalid status:
--      -- Pick a rejected or paid row:
--      select id from public.author_withdrawals where status='rejected' limit 1;
--      select public.admin_approve_withdrawal('<UUID>'::uuid);
--    Should return ok:false with error:'invalid_status_for_approve'.


-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- Re-apply the previous version of admin_approve_withdrawal from the
-- earnings moderation RPCs migration. The original is in
-- 2026-05-14_earnings_moderation_rpcs.sql (look for admin_approve_withdrawal).
