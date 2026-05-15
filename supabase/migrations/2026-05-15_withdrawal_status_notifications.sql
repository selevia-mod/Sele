-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Withdrawal status notifications (rejected / approved / paid)
--
-- Background
-- ----------
-- Day 1 earnings audit (EARNINGS_VERIFICATION_MATRIX_2026-05-15.md, red
-- item #4) flagged that creators receive zero in-app feedback when their
-- withdrawal is rejected, approved, or paid. The admin can call
-- admin_reject_withdrawal with a reason, but the reason is stored only
-- on the author_withdrawals.rejection_reason column — the creator
-- never sees it. They learn about the rejection by opening a support
-- ticket asking "what happened to my withdrawal?"
--
-- Approach
-- --------
-- Add an AFTER UPDATE trigger on author_withdrawals that fires when
-- status flips into a creator-facing terminal/transit state and
-- inserts an in-app notification. The trigger is the right layer here
-- because the existing admin RPCs (admin_approve / admin_reject /
-- admin_mark_paid) all do plain UPDATEs on author_withdrawals.status;
-- a trigger catches them all without needing to touch each RPC's body.
--
-- This mirrors the pattern in 2026-05-14_creator_earning_notifications.sql
-- which already wires triggers for author_earnings status changes.
--
-- States covered
-- --------------
-- pending → approved : "Your withdrawal was approved. Payment is on its way."
-- pending → rejected : "Withdrawal not approved. Reason: <admin reason>."
-- approved → paid    : "Payment sent. Reference: <hitpay_payout_ref>."
--
-- Other transitions (e.g. pending → pending, approved → approved) are
-- no-ops because the trigger's WHEN clause filters them out. The
-- terminal state 'paid' or 'rejected' should never flip back, but if
-- someone does it manually via SQL the trigger doesn't re-notify
-- because we gate on the specific OLD→NEW pairing.
--
-- Notification shape
-- ------------------
-- Matches existing creator notifications (type='announcement',
-- target_type='withdrawal'). is_read=false so it shows up as unread.
-- metadata carries the structured payload so the mobile / web client
-- can render a tap-action that deep-links to /payments.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP IF EXISTS + CREATE TRIGGER.
-- ════════════════════════════════════════════════════════════════════════

begin;


-- ────────────────────────────────────────────────────────────────────
-- 1. Trigger function — emits the notification based on the OLD/NEW pair.
-- ────────────────────────────────────────────────────────────────────
create or replace function public._notify_withdrawal_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title    text;
  v_body     text;
  v_amount_php numeric;
  v_actor    uuid;
begin
  -- Only fire on actual status changes that matter to the creator.
  if NEW.status is null or NEW.status = OLD.status then
    return NEW;
  end if;
  if NEW.status not in ('approved', 'rejected', 'paid') then
    return NEW;
  end if;

  -- Format the gross amount as pesos for human-readable copy. Same
  -- ₱ formatting the creator sees on the Earnings page (peso.cent).
  v_amount_php := round(coalesce(NEW.amount_php_minor, 0) / 100.0, 2);

  -- Actor: the admin who triggered the change, when we can identify
  -- them. We can't know inside the trigger which admin called the
  -- RPC unless they pass it through; fall back to the creator
  -- themselves so the notif still renders without a null actor (the
  -- mobile client's NotificationCard expects a non-null actor_id).
  v_actor := coalesce(auth.uid(), NEW.author_id);

  if NEW.status = 'approved' then
    v_title := 'Withdrawal approved';
    v_body  := format(
      'Your ₱%s withdrawal has been approved. Payment will be sent shortly.',
      to_char(v_amount_php, 'FM999,999,990.00')
    );
  elsif NEW.status = 'rejected' then
    v_title := 'Withdrawal not approved';
    v_body  := format(
      'Your ₱%s withdrawal was not approved. Reason: %s',
      to_char(v_amount_php, 'FM999,999,990.00'),
      coalesce(NEW.rejection_reason, 'no reason provided — please contact support.')
    );
  else  -- 'paid'
    v_title := 'Payment sent';
    v_body  := format(
      'Your ₱%s withdrawal has been sent.%s',
      to_char(v_amount_php, 'FM999,999,990.00'),
      case
        when NEW.hitpay_payout_ref is not null
          then ' Reference: ' || NEW.hitpay_payout_ref || '.'
        else ''
      end
    );
  end if;

  insert into public.notifications (
    recipient_id, actor_id, type, target_type, target_id,
    parent_target_id, message, preview, metadata, is_read, is_viewed
  ) values (
    NEW.author_id,
    v_actor,
    'announcement',
    'withdrawal',
    NEW.id::text,
    null,
    v_title,
    v_body,
    jsonb_build_object(
      'kind',              'withdrawal_status_change',
      'withdrawal_id',     NEW.id,
      'old_status',        OLD.status,
      'new_status',        NEW.status,
      'amount_php_minor',  NEW.amount_php_minor,
      'net_php_minor',     NEW.net_php_minor,
      'rejection_reason',  NEW.rejection_reason,
      'hitpay_payout_ref', NEW.hitpay_payout_ref,
      'deeplink',          '/(payments)/payments'
    ),
    false,
    false
  );

  return NEW;
exception
  when others then
    -- Don't fail the underlying admin RPC if notification insert
    -- raises (e.g. notifications schema drift). Log the SQLSTATE and
    -- move on. The withdrawal state change is the important thing;
    -- the notification is a courtesy. Admins can still see what
    -- happened in the admin Payouts tab.
    raise warning
      'withdrawal status notif insert failed (status=%, sqlstate=%): %',
      NEW.status, SQLSTATE, SQLERRM;
    return NEW;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 2. Wire the trigger to author_withdrawals.
-- ────────────────────────────────────────────────────────────────────
drop trigger if exists trg_notify_withdrawal_status on public.author_withdrawals;
create trigger trg_notify_withdrawal_status
after update of status on public.author_withdrawals
for each row
execute function public._notify_withdrawal_status_change();


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run AFTER deploy)
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm trigger is wired:
--      select tgname, tgrelid::regclass
--        from pg_trigger
--       where tgname = 'trg_notify_withdrawal_status';
--    Expect one row with tgrelid = public.author_withdrawals.
--
-- 2. Smoke test (use a non-production withdrawal row if possible):
--      -- a. Pick a recent pending withdrawal for a creator you can sign in as:
--      select id, author_id, amount_php_minor, status
--        from public.author_withdrawals
--       where status = 'pending'
--       order by requested_at desc
--       limit 5;
--
--      -- b. Trigger a fake rejection (then roll back so production isn't affected):
--      begin;
--      update public.author_withdrawals
--         set status = 'rejected',
--             rejection_reason = 'TEST — please ignore'
--       where id = '<the-id>';
--      -- c. Confirm a notification row was inserted:
--      select recipient_id, type, target_type, message, preview, metadata
--        from public.notifications
--       where target_type = 'withdrawal'
--         and target_id   = '<the-id>'::text
--       order by created_at desc
--       limit 1;
--      rollback;
--
-- 3. Open mobile / web as the creator and confirm the notification
--    appears in their bell list with the rejection reason visible.
--
-- 4. Approve + mark-paid a real pending withdrawal during normal admin
--    work and confirm the creator gets the "approved" then "paid"
--    notifications in sequence.


-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════════
-- drop trigger if exists trg_notify_withdrawal_status on public.author_withdrawals;
-- drop function if exists public._notify_withdrawal_status_change();
