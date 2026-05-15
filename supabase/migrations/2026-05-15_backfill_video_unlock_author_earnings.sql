-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Backfill author_earnings for orphaned video unlocks
--
-- User report (Charles 2026-05-15): "someone unlock his video, the other
-- users reduced the coins but owner of the video did not received an
-- earnings."
--
-- Root cause investigation:
--   • The unlock_video_threshold RPC debits the viewer's wallet and
--     inserts an `unlocks` row correctly.
--   • But it does NOT call credit_author_earnings, so the uploader's
--     `author_earnings` ledger never gets a matching row.
--   • For comparison: unlock_content + unlock_book_bulk both call
--     credit_author_earnings at the end of their happy path. The
--     video_threshold variant was overlooked.
--
-- Impact verified by:
--   select count(*), sum(paid_amount) from unlocks u
--     left join author_earnings ae
--       on ae.source_user_id = u.user_id
--      and ae.source_id      = u.target_id
--      and ae.source_type    = 'video'
--    where u.target_type = 'video' and ae.id is null;
--
-- 28 orphaned unlocks — every video unlock since the
-- unlock_video_threshold RPC went live.
--
-- This migration ONLY backfills the missing ledger rows. The function
-- itself is patched in a separate migration once we have its current
-- definition (running pg_get_functiondef separately).
--
-- Wrapped in begin/commit so partial failures roll back cleanly.
-- Idempotent against re-runs — the EXISTS guard skips any unlock that
-- already has a matching author_earnings row.
-- ════════════════════════════════════════════════════════════════════════════


begin;


-- ┌────────────────────────────────────────────────────────────────────────┐
-- │  Backfill author_earnings for video unlocks                            │
-- └────────────────────────────────────────────────────────────────────────┘
-- For each `unlocks` row where target_type='video' and there's no
-- matching author_earnings row yet, call credit_author_earnings with
-- the unlock's metadata. The helper handles share_pct, currency-to-php
-- conversion, hold window, and writes the audit row.
--
-- The EXISTS subquery is the idempotency guard — re-running this
-- migration won't double-credit.

do $$
declare
  v_unlock     record;
  v_video      record;
  v_credited   int := 0;
  v_skipped    int := 0;
begin
  for v_unlock in (
    select u.user_id, u.target_id, u.paid_currency, u.paid_amount, u.unlocked_at
      from public.unlocks u
     where u.target_type = 'video'
       and not exists (
         select 1 from public.author_earnings ae
          where ae.source_user_id = u.user_id
            and ae.source_id      = u.target_id
            and ae.source_type    = 'video'
       )
     order by u.unlocked_at
  ) loop

    -- Resolve uploader_id from the videos table. target_id is text;
    -- cast to uuid for the lookup.
    begin
      select v.uploader_id, v.title into v_video
        from public.videos v
       where v.id = v_unlock.target_id::uuid;
    exception when others then
      -- target_id wasn't a valid uuid (legacy Appwrite-hex unlock).
      v_video.uploader_id := null;
      v_video.title := null;
    end;

    if v_video.uploader_id is null then
      raise notice 'Skipping orphan: video % not found (or target_id not uuid)', v_unlock.target_id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Self-unlock check (author unlocked own video) — credit_author_earnings
    -- will skip these too, but better to count them here for visibility.
    if v_video.uploader_id = v_unlock.user_id then
      raise notice 'Skipping self-unlock: viewer = author for video %', v_unlock.target_id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    perform public.credit_author_earnings(
      v_video.uploader_id,
      v_unlock.user_id,
      'video',
      v_unlock.target_id,
      v_unlock.paid_amount,
      v_unlock.paid_currency
    );
    v_credited := v_credited + 1;
  end loop;

  raise notice 'Backfill complete: % credited, % skipped', v_credited, v_skipped;
end$$;


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
-- After running this migration, the orphaned-unlocks count should be 0
-- (or only contain self-unlocks / invalid target_ids which we
-- intentionally skip):
--
--   select count(*) from public.unlocks u
--     left join public.author_earnings ae
--       on ae.source_user_id = u.user_id
--      and ae.source_id      = u.target_id
--      and ae.source_type    = 'video'
--    where u.target_type = 'video' and ae.id is null;
--
-- Spot-check a specific affected author — they should now see their
-- newly-backfilled earnings in pending state (subject to the 14-day
-- hold window before becoming withdrawable):
--
--   select * from public.author_earnings
--    where author_id = '<uploader uuid>'
--    order by created_at desc
--    limit 10;
-- ════════════════════════════════════════════════════════════════════════════
