-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-17 — Hotfix: _notify_kyc_status references non-existent constraint
--
-- Background
-- ----------
-- 2026-05-15_admin_kyc_security_rpcs.sql defined the _notify_kyc_status
-- helper with this tail:
--
--     ) values (
--       p_recipient, ..., false, false
--     )
--     on conflict on constraint notifications_dedup_uniq do nothing;
--
-- The constraint `notifications_dedup_uniq` is REFERENCED but never
-- CREATED — no migration defines it. Postgres raises at INSERT time:
--
--     ERROR: constraint "notifications_dedup_uniq" for table
--            "notifications" does not exist  (SQLSTATE 42704)
--
-- Because admin_approve_kyc, admin_reject_kyc, and admin_revoke_kyc all
-- call _notify_kyc_status as their last step, every admin KYC action
-- raises a constraint error and rolls back the transaction. The admin
-- UI surfaces the message as:
--
--     "kyc-approve: constraint \"notifications_dedup_uniq\" for table
--      \"notifications\" does not exist"
--
-- Charles hit this on 2026-05-17 when trying to approve a pending KYC.
--
-- Fix
-- ---
-- Two options were considered:
--
--   (a) Create the missing constraint (e.g. UNIQUE on
--       (recipient_id, target_type, target_id, metadata->>'kind')).
--       Requires a schema change + backfill audit. Heavy for what
--       this needs.
--
--   (b) Drop the ON CONFLICT clause and add an explicit NOT EXISTS
--       pre-check inside the function for idempotency. Same effective
--       behavior, no schema change, much simpler.
--
-- This migration takes option (b). The dedup guard checks for a
-- recent notification (within the last 5 minutes) targeting the same
-- (recipient, target_type='kyc', target_id) with the same kind
-- ('kyc_status_change'). Two admins clicking Approve in quick
-- succession won't double-notify; a re-approval days later still gets
-- a fresh notification (which is the right product behavior — the
-- creator should be informed when their KYC is revoked then re-approved).
--
-- Rollback
-- --------
-- Re-apply 2026-05-15_admin_kyc_security_rpcs.sql (reintroduces the bug).
-- ════════════════════════════════════════════════════════════════════════

begin;

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
declare
  v_kind text := 'kyc_status_change';
begin
  -- Idempotency guard — skip if a notification of the same kind for
  -- the same recipient/target was emitted in the last 5 minutes.
  -- This replaces the ON CONFLICT ON CONSTRAINT clause from the
  -- original 2026-05-15 version, which referenced a constraint
  -- (notifications_dedup_uniq) that was never created. Result: every
  -- admin KYC action raised SQLSTATE 42704 and rolled back.
  if exists (
    select 1 from public.notifications n
     where n.recipient_id = p_recipient
       and n.type         = 'announcement'
       and n.target_type  = 'kyc'
       and n.target_id    = p_recipient::text
       and n.metadata->>'kind' = v_kind
       and n.created_at   > now() - interval '5 minutes'
  ) then
    return;
  end if;

  insert into public.notifications (
    recipient_id, actor_id, type, target_type, target_id,
    parent_target_id, message, preview, metadata, is_read, is_viewed
  ) values (
    p_recipient,
    coalesce(p_actor, p_recipient),
    'announcement',
    'kyc',
    p_recipient::text,                       -- target_id is text in notifications
    null,
    p_title,
    p_body,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('kind', v_kind),
    false,
    false
  );
exception
  when others then
    -- Don't fail the parent KYC RPC if the notification insert raises.
    -- Mirrors the same pattern used in _notify_withdrawal_status_change:
    -- the status change is the important thing; the notification is a
    -- courtesy. Admin can still see what happened in the admin UI.
    raise warning
      '_notify_kyc_status insert failed for recipient % (sqlstate=%): %',
      p_recipient, SQLSTATE, SQLERRM;
end;
$$;

notify pgrst, 'reload schema';

commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm the function body no longer mentions the phantom constraint:
--      select pg_get_functiondef('public._notify_kyc_status(uuid,uuid,text,text,jsonb)'::regprocedure);
--    The output should NOT contain "notifications_dedup_uniq".
--
-- 2. Smoke-test: as admin, approve a pending KYC. Should succeed; the
--    creator should see a "KYC approved" notification in their bell.
--    No constraint error.
--
-- 3. Idempotency check: click Approve twice in quick succession on the
--    same row. Second click should be a no-op (RPC's own
--    `already_approved` short-circuit handles this before the notify
--    runs, but if it didn't, the 5-minute dedup would still prevent
--    duplicate notifications).
--
-- 4. Re-approve path: revoke a KYC, wait 6 minutes, re-approve. The
--    creator should get a fresh "KYC approved" notification because
--    the 5-minute window has elapsed. Correct product behavior.
