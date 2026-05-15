-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Hybrid feed cohort analytics (Phase 6.1)
--
-- Goal: be able to run SQL queries that compare engagement metrics
-- between users on the new hybrid feed vs. the legacy feed, without
-- needing any client-side event logging. We piggyback on existing data
-- (post_views, posts.likes_count/comments_count, follows, etc.) and
-- bucket users into cohorts using the SAME hash function the mobile
-- client uses to decide rollout eligibility.
--
-- The mobile gate (lib/feature-flags.js) is:
--   FNV-1a 32-bit hash of user_id string, mod 100, < HYBRID_FEED_ROLLOUT_PERCENT
--
-- This migration adds:
--   1. public.fnv1a32_hash(text) → bigint
--      Byte-for-byte equivalent of the JS implementation. ASCII-safe
--      (all our user_ids are UUIDs, which are 7-bit ASCII).
--
--   2. public.hybrid_feed_cohort(user_id_text, rollout_percent)
--      Returns 'hybrid' or 'legacy'. Pass the same rollout_percent the
--      mobile constant is currently at, so cohorts match production.
--      Drift between the two means the same user could appear in one
--      cohort here and the other on device — keep them in sync.
--
-- Tester whitelist is NOT modeled here. If the always-on tester list
-- (HYBRID_FEED_ALWAYS_ON_USER_IDS) has only a handful of accounts, the
-- skew on aggregate metrics is negligible. If it grows past, say, 20
-- users, add a manual `where user_id not in (...)` clause to the
-- analytics queries below.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


-- ──────────────────────────────────────────────────────────────────
-- 1. fnv1a32_hash — byte-for-byte match with the JS implementation
-- ──────────────────────────────────────────────────────────────────
-- The JS version in lib/feature-flags.js:
--   let hash = 2166136261;
--   for (let i = 0; i < str.length; i += 1) {
--     hash ^= str.charCodeAt(i);
--     hash = (hash * 16777619) >>> 0;  // 32-bit unsigned wrap
--   }
--   return hash;
--
-- We use bigint (8-byte signed) for the working register because
-- intermediate multiplications can briefly exceed 32 bits before the
-- mask. After the mask each iteration the value is always in [0, 2^32).
create or replace function public.fnv1a32_hash(p_str text)
returns bigint
language plpgsql
immutable
strict
as $$
declare
  v_hash  bigint := 2166136261;  -- FNV offset basis (32-bit)
  v_prime bigint := 16777619;    -- FNV prime (32-bit)
  v_mask  bigint := 4294967295;  -- 2^32 - 1
  v_i     int;
  v_code  int;
begin
  for v_i in 1..length(p_str) loop
    -- JS uses UTF-16 code units; for ASCII inputs (UUIDs) this matches
    -- the byte value. We use ascii() which returns the same for
    -- ASCII chars. If you ever feed this non-ASCII text the SQL and
    -- JS will diverge — don't.
    v_code := ascii(substr(p_str, v_i, 1));
    v_hash := (v_hash # v_code) & v_mask;       -- XOR + 32-bit mask
    v_hash := (v_hash * v_prime) & v_mask;      -- multiply + 32-bit mask
  end loop;
  return v_hash;
end;
$$;

revoke all on function public.fnv1a32_hash(text) from public;
grant execute on function public.fnv1a32_hash(text) to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────
-- 2. hybrid_feed_cohort — same gating logic as the mobile client
-- ──────────────────────────────────────────────────────────────────
-- Pass in the user_id (as text — UUIDs cast cleanly) and the current
-- ROLLOUT_PERCENT mobile is shipping with. Returns 'hybrid' or 'legacy'.
--
-- Example: if mobile is at HYBRID_FEED_ROLLOUT_PERCENT = 25, you'd call
--   select public.hybrid_feed_cohort(id::text, 25) from profiles;
-- and the 25% bucket here will match the 25% bucket on device.
create or replace function public.hybrid_feed_cohort(
  p_user_id        text,
  p_rollout_percent int default 0
) returns text
language sql
immutable
strict
as $$
  select case
    when p_user_id is null or length(trim(p_user_id)) = 0 then 'legacy'
    when p_rollout_percent <= 0   then 'legacy'
    when p_rollout_percent >= 100 then 'hybrid'
    when (public.fnv1a32_hash(p_user_id) % 100)::int < p_rollout_percent then 'hybrid'
    else 'legacy'
  end;
$$;

revoke all on function public.hybrid_feed_cohort(text, int) from public;
grant execute on function public.hybrid_feed_cohort(text, int) to authenticated, anon;


notify pgrst, 'reload schema';


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
-- 1. Hash sanity — the FNV-1a output is deterministic and matches JS.
--    To verify cross-platform parity, run this in your SQL editor:
--      select public.fnv1a32_hash('hello world');
--    Then in a __DEV__ Metro session, run:
--      console.log(_fnv1a32('hello world'));   // import _fnv1a32 from feature-flags
--    Both should print the SAME integer. If they don't, the mobile
--    cohort gate and the server analytics will assign the same user to
--    different buckets — alert me before rolling forward.
--
-- 2. Cohort distribution — at 10% rollout, ~10% of profiles should
--    bucket into 'hybrid'. Allow ~2% variance on small samples.
--
--    select
--      public.hybrid_feed_cohort(id::text, 10) as cohort,
--      count(*) as users
--    from public.profiles
--    where is_guest = false and is_banned = false
--    group by 1
--    order by 1;
--
--    -- Expect a ~10/90 split. If you see 50/50 or 0/100, the hash
--    -- function is broken — alert me.
--
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- EXAMPLE ANALYTICS QUERIES — save these in your editor and re-run
-- periodically after each rollout-percent bump
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── Q1. Daily active users by cohort (last 7 days) ───────────────
--    -- Update the `10` below to whatever HYBRID_FEED_ROLLOUT_PERCENT
--    -- mobile is currently shipping with.
--    with active_users as (
--      select distinct user_id, date(viewed_at) as day
--        from public.post_views
--       where viewed_at > now() - interval '7 days'
--    ),
--    cohorted as (
--      select au.user_id, au.day,
--             public.hybrid_feed_cohort(au.user_id::text, 10) as cohort
--        from active_users au
--    )
--    select day, cohort, count(distinct user_id) as dau
--      from cohorted
--     group by day, cohort
--     order by day desc, cohort;
--
-- ─── Q2. Posts viewed per session (a scroll-depth proxy) ──────────
--    with views_by_user as (
--      select user_id,
--             count(*) as views_7d,
--             count(distinct post_id) as unique_posts_7d
--        from public.post_views
--       where viewed_at > now() - interval '7 days'
--       group by user_id
--    ),
--    cohorted as (
--      select v.*, public.hybrid_feed_cohort(v.user_id::text, 10) as cohort
--        from views_by_user v
--    )
--    select cohort,
--           count(*)                       as users,
--           round(avg(views_7d), 1)        as avg_views_per_user,
--           round(avg(unique_posts_7d), 1) as avg_unique_per_user
--      from cohorted
--     group by cohort
--     order by cohort;
--
--    -- A successful hybrid feed should show HIGHER avg_unique_per_user
--    -- (better content variety) and either equal or higher avg_views_per_user
--    -- (engagement). If hybrid is LOWER on both, something regressed.
--
-- ─── Q3. Engagement rate by cohort (likes + comments per view) ────
--    with cohorts as (
--      select id as user_id,
--             public.hybrid_feed_cohort(id::text, 10) as cohort
--        from public.profiles
--       where is_guest = false and is_banned = false
--    ),
--    views_7d as (
--      select user_id, count(*) as views
--        from public.post_views
--       where viewed_at > now() - interval '7 days'
--       group by user_id
--    ),
--    likes_7d as (
--      select user_id, count(*) as likes
--        from public.reactions
--       where target_type = 'post'
--         and created_at > now() - interval '7 days'
--       group by user_id
--    ),
--    comments_7d as (
--      select user_id, count(*) as comments
--        from public.comments
--       where created_at > now() - interval '7 days'
--         and post_id is not null
--       group by user_id
--    )
--    select c.cohort,
--           count(*) as users,
--           round(avg(coalesce(v.views, 0)), 1)                       as avg_views,
--           round(avg(coalesce(l.likes, 0)), 2)                       as avg_likes,
--           round(avg(coalesce(cm.comments, 0)), 2)                   as avg_comments,
--           round(
--             100.0 * sum(coalesce(l.likes, 0) + coalesce(cm.comments, 0))
--                   / nullif(sum(coalesce(v.views, 0)), 0),
--             2
--           ) as engagement_pct
--      from cohorts c
--      left join views_7d v    on v.user_id  = c.user_id
--      left join likes_7d l    on l.user_id  = c.user_id
--      left join comments_7d cm on cm.user_id = c.user_id
--     group by c.cohort
--     order by c.cohort;
--
-- ─── Q4. Book carousel / video card tap-through (post-Phase 5B) ───
--    -- Requires the books table's downloads/reads counters and the
--    -- videos.views_count to have grown since the rollout. Compare
--    -- the deltas between two snapshots taken before/after a rollout
--    -- bump — that's your tap-through signal.
--
--    -- (Tap-through events would be cleaner if we had explicit event
--    -- logging, but inferring from view-count deltas is a reasonable
--    -- proxy for now.)
-- ════════════════════════════════════════════════════════════════════════════
