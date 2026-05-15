-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Partial UNIQUE on author_earnings (forward-only)
--
-- Background — the "no claw-back" decision (Charles, 2026-05-15)
-- ────────────────────────────────────────────────────────────────────
-- Day 2.2 investigation found ~₱15,290 of pre-existing duplicate
-- author_earnings rows from a check-then-insert race on the unlock
-- RPCs. Two options were considered:
--
--   A) Soft-dedupe: flip the extras to status='reversed'. Creators'
--      balances drop to reflect their actual earned amount. Platform
--      absorbs no cost.
--   B) Leave existing earnings in place. Platform absorbs the ~₱15,290
--      cost as affected creators withdraw against their inflated
--      balances. Brand-trust commitment: what's on the screen is what
--      you've earned, even if we put it there by mistake.
--
-- Charles picked B. This migration reflects that decision: existing
-- duplicate rows are left untouched. The partial UNIQUE has a
-- created_at >= '<cutoff>' predicate so it ONLY enforces uniqueness
-- on rows inserted from the cutoff timestamp forward. Anything that
-- existed before the cutoff (including all the duplicates we found
-- in the investigation) is permitted to remain.
--
-- The cutoff timestamp is set to 2026-05-15 18:00:00 UTC (Manila
-- 02:00 the next morning). This is safely AFTER the latest duplicate
-- created_at we saw in the investigation (2026-05-14 10:18 UTC) and
-- gives us a few hours of buffer in case any straggler duplicates
-- landed during our audit work today. Adjust the cutoff if you're
-- deploying significantly later than 2026-05-15 18:00 UTC — the
-- only requirement is that the cutoff must be AFTER the latest
-- known duplicate's created_at.
--
-- What this catches going forward:
--   • Future check-then-insert races on unlock_content,
--     unlock_book_bulk, and unlock_video_threshold (coin path).
--   • Any buggy backfill that tries to credit the same (user, source)
--     pair twice.
--   • Any admin SQL mistake that inserts a duplicate.
--
-- When the constraint trips, the offending INSERT raises SQLSTATE
-- 23505, the surrounding PL/pgSQL transaction rolls back, the wallet
-- deduct doesn't land, and the user gets an error. Safe failure mode.
--
-- Star-path earnings are intentionally excluded — consecutive
-- window-mode star payments at different thresholds carry the same
-- (source_user_id, source_type, source_id) by design.
-- ════════════════════════════════════════════════════════════════════════

begin;

create unique index if not exists author_earnings_uniq_coin
  on public.author_earnings (source_user_id, source_type, source_id)
  where coalesce(currency_used, 'coin') = 'coin'
    and created_at >= '2026-05-15 18:00:00+00'::timestamptz;

commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
-- 1. Confirm the index applied:
--    select indexname, indexdef from pg_indexes
--     where tablename = 'author_earnings'
--       and indexname = 'author_earnings_uniq_coin';
--
-- 2. Smoke test (replace UUIDs with real ones from a test author/user):
--    Try inserting two author_earnings rows with the same
--    (source_user_id, source_type, source_id) and currency='coin' and
--    created_at = now(). The second insert should fail with 23505.
--
-- 3. Sanity check: confirm pre-cutoff duplicate rows are still in place:
--    select count(*) from public.author_earnings
--     where source_type = 'book_bulk'
--       and created_at < '2026-05-15 18:00:00+00'::timestamptz;
--    Should match what we saw in the duplicates investigation (no rows
--    were touched by this migration).


-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- drop index if exists public.author_earnings_uniq_coin;
--
-- Rolling back leaves us protected against video-path races (the
-- advisory lock on unlock_video_threshold is independent of this
-- index) but exposes us again to chapter/book_bulk races until the
-- advisory locks land on those two RPCs.
