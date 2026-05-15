-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Fix _notify_withdrawal_status_change uuid/text mismatch
--
-- Background
-- ----------
-- The original 2026-05-15_withdrawal_status_notifications.sql wrote
--   target_id = NEW.id::text
-- inside its INSERT into public.notifications. But notifications.target_id
-- is a `uuid` column, not text. Postgres cannot implicitly cast text →
-- uuid for assignment, so every trigger fire raised
--   ERROR 42804: column "target_id" is of type uuid but expression is of type text
-- That error was caught by the function's `when others then raise warning`
-- block, so the underlying admin RPC's UPDATE on author_withdrawals
-- succeeded normally — but no notification row was ever inserted.
--
-- Symptom in the smoke test:
--   • Trigger trg_notify_withdrawal_status installed (tgenabled='O').
--   • author_withdrawals.status flipped pending → approved successfully.
--   • Zero rows in public.notifications for the withdrawal.
--   • Creator's phone never buzzed.
--
-- Diagnosed by extracting the trigger's INSERT body and running it as a
-- standalone statement (withdrawal-notif-diagnostic.sql §B). The
-- standalone INSERT raised the type-mismatch error, which was being
-- silently swallowed inside the trigger.
--
-- Fix
-- ---
-- Drop the `::text` cast. NEW.id is already uuid, target_id is uuid —
-- straight assignment works without a cast.
-- ════════════════════════════════════════════════════════════════════════

begin;

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
    NEW.id,                              -- ← FIX: was NEW.id::text
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

commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run AFTER deploy)
-- ════════════════════════════════════════════════════════════════════════
-- 1. Confirm the function source matches above:
--      select pg_get_functiondef('public._notify_withdrawal_status_change'::regprocedure);
--    Look for `NEW.id,` (no ::text) on the target_id line.
--
-- 2. Smoke test: pick a pending withdrawal and approve it via the admin
--    UI (or directly UPDATE author_withdrawals.status = 'approved'
--    inside a transaction with rollback). Then:
--      select id, recipient_id, type, target_type, message
--        from public.notifications
--       where target_type = 'withdrawal'
--         and target_id   = '<the-withdrawal-id>'::uuid
--       order by created_at desc
--       limit 1;
--    Should return one row.
--
-- 3. Open mobile / web as the creator and confirm the notification
--    appears in the bell with the right copy and routes to the
--    payments page on tap.


-- ════════════════════════════════════════════════════════════════════════
-- BACKFILL (one-time)
-- ════════════════════════════════════════════════════════════════════════
-- Any withdrawals that were approved / rejected / paid BEFORE this fix
-- went out missed their notification because the trigger was silently
-- failing. Use this to surface them and decide whether to backfill the
-- missing notifications.
--
-- /*
-- select w.id, w.author_id, w.status, w.approved_at, w.amount_php_minor
--   from public.author_withdrawals w
--   left join public.notifications n
--     on n.target_type = 'withdrawal' and n.target_id = w.id
--  where w.status in ('approved', 'rejected', 'paid')
--    and n.id is null
--  order by w.approved_at desc nulls last;
-- */
--
-- For the smoke-test row we identified earlier (5261067b-...), you can
-- backfill manually with:
--
-- /*
-- begin;
-- update public.author_withdrawals
--    set status = 'approved'
--  where id = '5261067b-199a-4599-abcd-f2a850ea8e0a'
--    and status = 'approved';   -- no-op UPDATE, but the trigger fires? NO.
-- rollback;
-- */
--
-- That trick won't work because the trigger has `if NEW.status = OLD.status
-- then return NEW; end if`. A no-op UPDATE doesn't fire the notification.
-- The cleanest backfill is to insert the notification row directly, which
-- the next section of the diagnostic file does (§B-fix variant).
