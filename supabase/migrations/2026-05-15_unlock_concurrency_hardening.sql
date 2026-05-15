-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Unlock concurrency hardening + author_earnings dedup guard
--
-- Background
-- ----------
-- The earnings audit (Day 1, see EARNINGS_VERIFICATION_MATRIX_2026-05-15.md)
-- flagged a check-then-insert race in three unlock RPCs:
--
--   unlock_content        (chapter unlock, coin)
--   unlock_book_bulk      (multi-chapter unlock, coin)
--   unlock_video_threshold (coin path AND star path)
--
-- The pattern is:
--   if exists (select 1 from unlocks where (user, target)) then return ok;
--   ... deduct wallet, credit author ...
--   insert into unlocks ... on conflict do nothing;
--
-- Two concurrent transactions for the same (user, target) — e.g. two
-- devices, two taps within milliseconds, OR a network retry that
-- overlaps with the original — can both pass the `if exists` check,
-- both deduct the wallet, both credit the author. The `on conflict do
-- nothing` on the unlocks insert is too late; the financial damage is
-- already done on both wallets.
--
-- The star path on unlock_video_threshold is even worse — it has no
-- unlocks row to conflict on; only a video_progress UPSERT, and the
-- SELECT before it isn't FOR UPDATE.
--
-- Fix
-- ---
-- Add a PostgreSQL transaction-scoped advisory lock at the top of each
-- unlock RPC, keyed on the unlock target. Two concurrent transactions
-- with the same target will serialize — the second one blocks until
-- the first commits, then sees the committed state and short-circuits
-- via the existing `if exists` check.
--
-- Advisory locks are released automatically when the transaction ends
-- (commit OR rollback) so there's no cleanup risk. The lock is keyed
-- on (user_id, target_type, target_id) so different unlocks don't
-- block each other.
--
-- Defense-in-depth — also add a partial UNIQUE index on author_earnings
-- so the database itself refuses to accept a duplicate coin-path
-- earning row even if a future code change re-introduces the race.
-- Star-path earnings are intentionally excluded because consecutive
-- window-mode payments at different thresholds carry the same
-- (source_user_id, source_type, source_id) but represent legitimate
-- separate transactions; the threshold isn't currently in author_earnings.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + CREATE UNIQUE INDEX IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════

begin;


-- ────────────────────────────────────────────────────────────────────
-- 1. Partial UNIQUE index — defense in depth for coin paths
-- ────────────────────────────────────────────────────────────────────
-- Prevents duplicate INSERT into author_earnings for the same coin-path
-- unlock. If this constraint trips, the unlock RPC's INSERT fails with
-- SQLSTATE 23505 and the entire transaction rolls back — which means
-- the wallet deduct AND any other side effects also roll back. The
-- user's first successful unlock wins; the second one returns an
-- error to the client and nothing happens. Safer than letting the
-- duplicate credit land.
--
-- The `WHERE` clause limits the constraint to coin-path rows (or
-- legacy rows with null currency_used). Star-path rows can legitimately
-- duplicate by (user, video) when paid at different thresholds.
create unique index if not exists author_earnings_uniq_coin
  on public.author_earnings (source_user_id, source_type, source_id)
  where coalesce(currency_used, 'coin') = 'coin';


-- ────────────────────────────────────────────────────────────────────
-- 2. Helper — compute a 64-bit advisory-lock key from (user, target)
-- ────────────────────────────────────────────────────────────────────
-- Postgres advisory locks take a bigint. We hash the concatenation of
-- the unlock identifier into a stable bigint via hashtext (returns int,
-- 32 bits) cast to bigint. Two different unlocks would need to
-- collide on the same 32-bit hash, which is rare enough not to block
-- unrelated requests in practice.
create or replace function public._unlock_lock_key(
  p_user_id     uuid,
  p_target_type text,
  p_target_id   text
) returns bigint
language sql
immutable
as $$
  select abs(hashtext(p_user_id::text || ':' || p_target_type || ':' || p_target_id))::bigint;
$$;

revoke all on function public._unlock_lock_key(uuid, text, text) from public;
grant execute on function public._unlock_lock_key(uuid, text, text) to authenticated, service_role;


-- ────────────────────────────────────────────────────────────────────
-- 3. unlock_video_threshold — add advisory lock at top of function
-- ────────────────────────────────────────────────────────────────────
-- The full function body is preserved from
-- 2026-05-15_unlock_video_threshold_credit_author.sql; only the
-- advisory-lock block is added near the top, right after the input
-- validation. Once the lock is held, the rest of the function
-- (resolve uuid, exists-check, deduct, insert, credit) runs serially
-- per (user, target).
--
-- The lock is taken AFTER auth check + currency validation so that
-- malformed requests don't pay the lock-acquisition cost. It's taken
-- BEFORE the unlocks exists-check so the existing short-circuit
-- still works.
create or replace function public.unlock_video_threshold(
  p_video_id          text,
  p_currency          text,
  p_threshold_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id        uuid := auth.uid();
  v_video_uuid     uuid;
  v_legacy         bool := p_video_id like 'aw\_%' or p_video_id like 'sb\_%';
  v_cost           int;
  v_balance_after  int;
  v_recurring      int := coalesce(public.get_config_int('video_recurring_unlock_seconds'), 600);
  v_progress       record;
  v_author_id      uuid;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_currency not in ('coin', 'star') then
    return jsonb_build_object('ok', false, 'error', 'invalid_currency');
  end if;
  if p_threshold_seconds is null or p_threshold_seconds < 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_threshold');
  end if;

  -- ── ADVISORY LOCK (added 2026-05-15) ──────────────────────────────
  -- Serializes concurrent unlock attempts on the same (user, video).
  -- The lock is auto-released at COMMIT or ROLLBACK. A second concurrent
  -- transaction blocks here until the first finishes; when it resumes,
  -- the exists-check (or paid_through check for stars) sees the
  -- committed state and short-circuits.
  perform pg_advisory_xact_lock(public._unlock_lock_key(v_user_id, 'video', p_video_id));

  if v_legacy then
    v_video_uuid := null;
    select id, uploader_id into v_video_uuid, v_author_id
      from public.videos
     where legacy_appwrite_id = p_video_id;
  else
    begin v_video_uuid := p_video_id::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'invalid_video_id');
    end;
    select uploader_id into v_author_id from public.videos where id = v_video_uuid;
  end if;

  if exists (
    select 1 from public.unlocks
    where user_id = v_user_id and target_type = 'video' and target_id = p_video_id
  ) then
    return jsonb_build_object('ok', true, 'already_permanent', true);
  end if;

  if v_video_uuid is not null then
    select * into v_progress
      from public.video_progress
     where user_id = v_user_id and video_id = v_video_uuid;
    if found and v_progress.paid_through_seconds >= p_threshold_seconds then
      return jsonb_build_object('ok', true, 'already_paid_for_threshold', true,
                                'paid_through_seconds', v_progress.paid_through_seconds);
    end if;
  end if;

  v_cost := public.get_config_int(
    case when p_currency = 'coin'
         then 'default_video_unlock_coins'
         else 'default_video_unlock_stars'
    end
  );
  if v_cost is null or v_cost <= 0 then
    return jsonb_build_object('ok', false, 'error', 'cost_unresolved');
  end if;

  if p_currency = 'coin' then
    update public.wallets
       set coin_balance = coin_balance - v_cost,
           updated_at   = now()
     where user_id = v_user_id and coin_balance >= v_cost
     returning coin_balance into v_balance_after;
  else
    update public.wallets
       set star_balance = star_balance - v_cost,
           updated_at   = now()
     where user_id = v_user_id and star_balance >= v_cost
     returning star_balance into v_balance_after;
  end if;

  if v_balance_after is null then
    return jsonb_build_object('ok', false, 'error', 'insufficient_balance',
                              'cost', v_cost, 'currency', p_currency,
                              'threshold_seconds', p_threshold_seconds);
  end if;

  if p_currency = 'coin' then
    insert into public.unlocks (user_id, target_type, target_id, paid_currency, paid_amount, source)
      values (v_user_id, 'video', p_video_id, 'coin', v_cost, 'web')
      on conflict (user_id, target_type, target_id) do nothing;

    if v_video_uuid is not null then
      insert into public.video_progress (user_id, video_id, max_position_seconds, paid_through_seconds, updated_at)
        values (v_user_id, v_video_uuid, p_threshold_seconds, 2147483647, now())
        on conflict (user_id, video_id) do update
        set paid_through_seconds = greatest(public.video_progress.paid_through_seconds, excluded.paid_through_seconds),
            max_position_seconds = greatest(public.video_progress.max_position_seconds, excluded.max_position_seconds),
            updated_at = now();
    end if;

    insert into public.coin_transactions
      (user_id, delta, balance_after, type, reference_type, reference_id, metadata)
    values
      (v_user_id, -v_cost, v_balance_after, 'unlock_video', 'video', p_video_id,
       jsonb_build_object('threshold_seconds', p_threshold_seconds, 'mode', 'permanent'));

    if v_author_id is not null then
      perform public.credit_author_earnings(
        v_author_id, v_user_id, 'video', p_video_id, v_cost, 'coin'
      );
    end if;

    return jsonb_build_object('ok', true, 'mode', 'permanent', 'cost', v_cost,
                              'currency', 'coin', 'balance_after', v_balance_after);
  end if;

  if v_video_uuid is not null then
    insert into public.video_progress (user_id, video_id, max_position_seconds, paid_through_seconds, updated_at)
      values (v_user_id, v_video_uuid,
              greatest(p_threshold_seconds, p_threshold_seconds + v_recurring - 1),
              p_threshold_seconds + v_recurring - 1,
              now())
      on conflict (user_id, video_id) do update
      set paid_through_seconds = greatest(public.video_progress.paid_through_seconds, excluded.paid_through_seconds),
          max_position_seconds = greatest(public.video_progress.max_position_seconds, excluded.max_position_seconds),
          updated_at = now();
  end if;

  insert into public.star_transactions
    (user_id, delta, balance_after, type, reference_type, reference_id, metadata)
  values
    (v_user_id, -v_cost, v_balance_after, 'unlock_video', 'video', p_video_id,
     jsonb_build_object('threshold_seconds', p_threshold_seconds, 'mode', 'window',
                        'paid_through_seconds', p_threshold_seconds + v_recurring - 1));

  if v_author_id is not null then
    perform public.credit_author_earnings(
      v_author_id, v_user_id, 'video', p_video_id, v_cost, 'star'
    );
  end if;

  return jsonb_build_object('ok', true, 'mode', 'window', 'cost', v_cost,
                            'currency', 'star', 'balance_after', v_balance_after,
                            'paid_through_seconds', p_threshold_seconds + v_recurring - 1);
end;
$$;

revoke all on function public.unlock_video_threshold(text, text, integer) from public;
grant execute on function public.unlock_video_threshold(text, text, integer) to authenticated, anon;


-- ────────────────────────────────────────────────────────────────────
-- 4. unlock_content (chapter unlock) — same advisory-lock treatment
-- ────────────────────────────────────────────────────────────────────
-- We CANNOT inline the full function body here because it lives across
-- multiple migrations (canonicalize hotfix, wallet ensure, etc.) and
-- recreating it would risk drift. Instead we wrap the existing function
-- with a thin pre-amble using ALTER FUNCTION ... SET (not supported for
-- function body changes) — so we have to CREATE OR REPLACE the full
-- body.
--
-- Charles: please confirm the most recent canonical version of
-- unlock_content lives in migration_unlock_rpcs_actor_id_fallback.sql
-- (or wherever it was last touched) BEFORE running this migration
-- block. We'll re-emit unlock_content + unlock_book_bulk in the next
-- pass once we've verified the source-of-truth function body.
--
-- For Saturday's withdrawal re-enable, the unlock_video_threshold
-- advisory lock above is the most important addition (it's the only
-- path with the star-side race AND the most recently changed). The
-- chapter/book_bulk paths are still vulnerable to the same race but
-- the partial UNIQUE on author_earnings (section 1) catches duplicates
-- at the DB level for them.
--
-- TODO: emit canonical unlock_content + unlock_book_bulk with advisory
-- locks in a follow-up migration after confirming the latest function
-- body.


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run AFTER deploy)
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm partial UNIQUE index exists:
--      select indexname, indexdef from pg_indexes
--       where tablename = 'author_earnings'
--         and indexname = 'author_earnings_uniq_coin';
--
-- 2. Confirm advisory-lock helper exists:
--      select proname from pg_proc where proname = '_unlock_lock_key';
--
-- 3. Confirm unlock_video_threshold has the advisory lock:
--      select pg_get_functiondef(oid) from pg_proc
--       where proname = 'unlock_video_threshold';
--    Search for the substring "pg_advisory_xact_lock". Should appear once.
--
-- 4. Smoke test: unlock a video from two browser tabs simultaneously.
--    Confirm:
--      a. Only one author_earnings row is created
--      b. Only one wallet debit happens
--      c. Second tab returns already_permanent=true or already_paid_for_threshold=true
--
-- 5. Run the duplicates diagnostic again (earnings-duplicates-diagnostic.sql).
--    Confirm no NEW duplicates accumulate after this migration is live.
--    (Pre-existing duplicates from before this migration need separate
--    dedup — see the diagnostic for the existing count.)


-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════════
-- To roll back the partial UNIQUE index (if it blocks legitimate writes
-- in an unforeseen way):
--   drop index if exists public.author_earnings_uniq_coin;
--
-- To roll back the advisory lock in unlock_video_threshold, re-apply
-- 2026-05-15_unlock_video_threshold_credit_author.sql (the previous version).
--
-- The _unlock_lock_key helper is harmless to leave in place even after
-- rollback.
