-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Unlock advisory lock (1A of 2)
--
-- Split off from 2026-05-15_unlock_concurrency_hardening.sql because the
-- partial UNIQUE index in that file failed to apply on existing data —
-- production has pre-existing duplicate author_earnings rows that need
-- to be deduplicated first. See earnings-duplicates-investigate.sql for
-- the investigation queries.
--
-- This migration ONLY ships the advisory lock + helper function. It
-- doesn't touch author_earnings rows. It's safe to run immediately
-- regardless of how many historical duplicates exist.
--
-- What this prevents going forward:
--   Two concurrent transactions on unlock_video_threshold can no longer
--   both pass the check-then-insert race window. The advisory lock
--   serializes them per (user, video) so the second transaction
--   short-circuits via the existing exists-check or paid_through check.
--
-- What this does NOT prevent:
--   - The same race in unlock_content (chapter unlock) and
--     unlock_book_bulk (multi-chapter unlock). Those RPCs need their
--     own advisory-lock retrofit; we can't safely CREATE OR REPLACE
--     them here without the canonical source body. Will land in a
--     follow-up migration.
--   - Already-existing duplicate rows. Those need a separate dedupe
--     migration; see earnings-duplicates-investigate.sql first.
--
-- The partial UNIQUE index (defense-in-depth) waits for migration 1B
-- which runs after dedupe is committed.
-- ════════════════════════════════════════════════════════════════════════

begin;


-- ────────────────────────────────────────────────────────────────────
-- 1. Helper — compute a 64-bit advisory-lock key from (user, target)
-- ────────────────────────────────────────────────────────────────────
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
-- 2. unlock_video_threshold — add advisory lock
-- ────────────────────────────────────────────────────────────────────
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


commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
-- select pg_get_functiondef(oid) from pg_proc where proname = 'unlock_video_threshold';
-- Confirm the body contains the string 'pg_advisory_xact_lock'.
