-- ════════════════════════════════════════════════════════════════════════
-- Diagnostic: why didn't the withdrawal-status trigger insert a row?
--
-- Background
-- ----------
-- 2026-05-15 smoke test:
--   • Trigger trg_notify_withdrawal_status is installed (tgenabled='O').
--   • The test withdrawal flipped from pending → approved cleanly
--     (status='approved', approved_at set, approved_by set).
--   • But SELECT count(*) FROM notifications WHERE target_type='withdrawal'
--     returned 0 rows for that withdrawal_id.
--   • Manual INSERT into notifications with the same shape DID succeed.
--
-- The trigger function _notify_withdrawal_status_change has a
--   exception when others then raise warning ...
-- block at the bottom — meaning if the INSERT inside the trigger raises
-- ANY error (CHECK constraint, FK violation, NOT NULL violation, type
-- mismatch), the trigger swallows the error, emits a WARNING to the
-- Postgres log (which we don't see in the SQL editor), and lets the
-- underlying status UPDATE proceed normally. That's exactly what we
-- observed: status flipped, notification missing.
--
-- This file isolates the INSERT and runs it as a standalone statement
-- so any error surfaces directly in the editor instead of being
-- buried in the log.
--
-- HOW TO USE
-- ----------
-- Copy the §A and §B blocks one at a time. Each block prints what it
-- would insert and then attempts the actual INSERT. If §B raises, you
-- get the real error message. If §B succeeds, the trigger's INSERT
-- logic is fine and the failure is somewhere else (e.g. Supabase
-- migrations weren't actually deployed, the function body in
-- production differs from the migration file, or auth.uid() returns
-- something that fails an RLS write — though SECURITY DEFINER should
-- bypass RLS).
-- ════════════════════════════════════════════════════════════════════════


-- ─── §A. Find the most recent approved withdrawal that has NO notif ────
-- This is the row we'll smoke-test against. Capture the id + author_id
-- output and substitute into §B below.
select
  w.id                            as withdrawal_id,
  w.author_id                     as author_id,
  w.status                        as status,
  w.amount_php_minor              as amount_minor,
  w.rejection_reason              as rejection_reason,
  w.hitpay_payout_ref             as hitpay_payout_ref,
  w.approved_at                   as approved_at,
  (select count(*)
     from public.notifications n
    where n.target_type = 'withdrawal'
      and n.target_id   = w.id::text)   as existing_notif_count
from public.author_withdrawals w
where w.status in ('approved', 'rejected', 'paid')
  and w.approved_at >= now() - interval '24 hours'
order by w.approved_at desc nulls last
limit 5;


-- ─── §B. Run the trigger's INSERT body as a standalone statement ──────
-- Replace the 4 placeholder values with values from §A.
-- This is the EXACT shape the trigger inserts. If something here
-- raises, you'll see the real Postgres error code + message.
--
-- Wrapped in a transaction so you can inspect + rollback. Promote to
-- commit only if you actually want this notification to land.

/*
begin;

insert into public.notifications (
  recipient_id, actor_id, type, target_type, target_id,
  parent_target_id, message, preview, metadata, is_read, is_viewed
) values (
  '<author_id from §A>'::uuid,                -- recipient_id
  '<author_id from §A>'::uuid,                -- actor_id (fallback to author per trigger)
  'announcement',
  'withdrawal',
  '<withdrawal_id from §A>'::text,            -- target_id (cast as the trigger does)
  null,                                       -- parent_target_id
  'Withdrawal approved',                      -- message (title)
  'Your ₱100.00 withdrawal has been approved. Payment will be sent shortly.',
  jsonb_build_object(
    'kind',              'withdrawal_status_change',
    'withdrawal_id',     '<withdrawal_id from §A>',
    'old_status',        'pending',
    'new_status',        'approved',
    'amount_php_minor',  10000,
    'net_php_minor',     9700,
    'rejection_reason',  null,
    'hitpay_payout_ref', null,
    'deeplink',          '/(payments)/payments'
  ),
  false,
  false
)
returning id, recipient_id, type, target_type, target_id;

-- If the insert returned a row above, the trigger's INSERT logic is
-- fine. The failure must be elsewhere (deployment lag, auth.uid()
-- raising in the trigger context, a different function body in prod).
-- Run §C below to inspect the actual function source in the database.

rollback;
*/


-- ─── §C. Diff the deployed function body against the migration file ───
-- Pulls the exact source Postgres has compiled. Compare against
-- supabase/migrations/2026-05-15_withdrawal_status_notifications.sql
-- by eyeballing — any divergence (older revision, hand-edits) explains
-- why the trigger doesn't behave as expected.

select pg_get_functiondef('public._notify_withdrawal_status_change'::regprocedure);


-- ─── §D. Is the trigger event-trigger linked correctly? ────────────────
-- Confirms tgrelid points at author_withdrawals, tgenabled='O',
-- tgtype encodes "after update" with the OF status column list.

select
  tgname,
  tgrelid::regclass        as table_name,
  tgenabled                as enabled_state,
  tgtype                   as type_bitmask,
  pg_get_triggerdef(oid)   as trigger_def
from pg_trigger
where tgname = 'trg_notify_withdrawal_status';


-- ─── §E. Most recent Postgres warnings (if you have log access) ───────
-- Supabase exposes the Postgres logs in the dashboard:
--   Project → Database → Logs → Postgres Logs
-- Filter for "withdrawal status notif insert failed" — that's the
-- warning emitted by the exception handler in the trigger function.
-- The warning text includes SQLSTATE + SQLERRM which tells you
-- exactly what raised.
--
-- If §B above succeeds but the trigger still doesn't insert during
-- a real status flip, that warning in the log is the answer.
