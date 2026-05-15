-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — unlock_video_threshold: credit author on BOTH coin + star
--
-- Bug verified 2026-05-15 (Charles user report): video unlocks deducted
-- the viewer's wallet but didn't pay the video's uploader.
--
-- Two issues in the live function (captured via pg_get_functiondef):
--
-- BUG A — Star path skips credit_author_earnings entirely.
--   The comment line read "-- Star path → no unlocks row, no author
--   earnings (stars are free)". Stars are NOT free — users either pay
--   for them (HitPay top-up) or earn them via rewarded ads. The
--   credit_author_earnings helper already supports star currency via
--   the star_to_php_minor config. The skip was the bug.
--
-- BUG B — Legacy video IDs (aw_*/sb_* prefix) never reach the credit
--   call because the function short-circuits to v_video_uuid := null
--   without resolving uploader_id. We now resolve uploader via the
--   legacy_appwrite_id column so legacy unlocks credit too.
--
-- Companion artifacts shipped today:
--   • 2026-05-15_backfill_video_unlock_author_earnings.sql — credits
--     the 28 already-affected coin unlocks. Star-path orphans aren't
--     reachable from `unlocks` (those rows never existed); they'd need
--     a separate backfill from star_transactions if Charles wants to
--     retroactively credit affected creators. Cost-benefit: low (small
--     amounts per star unlock, hard to identify the right rows
--     unambiguously). Leaving as a TODO unless flagged.
--
--   • lib/earnings-supabase.js — Total Earnings now excludes pending
--     (under-review) earnings. Surfaces them in the Pending tile only.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


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

  -- Resolve video uuid + uploader_id. For BUG B fix: legacy aw_*/sb_*
  -- ids now look up via legacy_appwrite_id so the credit call can fire
  -- on those too. Without this, every legacy video unlock leaked free
  -- content to the viewer.
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

    -- Credit the video's uploader. Passes p_currency='coin' explicitly
    -- so credit_author_earnings uses the coin_to_php_minor conversion
    -- (default 20¢ per coin per app_config) and reads the hold-days
    -- config to set status='pending' until the review window expires.
    if v_author_id is not null then
      perform public.credit_author_earnings(
        v_author_id, v_user_id, 'video', p_video_id, v_cost, 'coin'
      );
    end if;

    return jsonb_build_object('ok', true, 'mode', 'permanent', 'cost', v_cost,
                              'currency', 'coin', 'balance_after', v_balance_after);
  end if;

  -- Star path (window mode) — viewer pays stars for a 10-min window of
  -- access starting at the threshold. Same author-earnings credit as
  -- the coin path now. The previous version skipped this entirely.
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

  -- BUG A fix — credit the uploader for star-paid unlocks too. Star
  -- earnings get the star_to_php_minor conversion (default 5¢ per
  -- star per app_config). credit_author_earnings is currency-aware.
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


notify pgrst, 'reload schema';


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
-- After running this migration AND the backfill migration:
--
-- 1. Run a test unlock (coin) and confirm a new author_earnings row
--    appears for the video's uploader within seconds:
--
--      select id, source_type, source_id, gross_coins, net_php_minor,
--             currency_used, status, available_at, created_at
--        from public.author_earnings
--       where source_user_id = '<test viewer uuid>'
--         and source_type   = 'video'
--       order by created_at desc
--       limit 5;
--
-- 2. Run a test unlock (star) and confirm the same — previously no row
--    would have been written for star unlocks.
--
-- 3. Re-run the orphan check from earlier:
--
--      select count(*) from public.unlocks u
--        left join public.author_earnings ae
--          on ae.source_user_id = u.user_id
--         and ae.source_id      = u.target_id
--         and ae.source_type    = 'video'
--       where u.target_type = 'video' and ae.id is null;
--
--    Expect: 0 (or only self-unlocks if those happen to exist).
-- ════════════════════════════════════════════════════════════════════════════
