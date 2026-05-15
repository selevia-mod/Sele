-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Video card injection (Phase 5B of the feed redesign)
--
-- Adds a "video_card" item type to the hybrid feed. One trending video is
-- injected per slot-7 mark, alternating with the book_carousel that
-- already lives there. Visible cadence on mobile:
--
--   6 posts → BOOK CAROUSEL → 6 posts → VIDEO CARD → 6 posts → BOOK CAROUSEL → ...
--
-- Two pieces:
--
--   1. New RPC: fetch_video_card(p_exclude_ids uuid[])
--      Returns a single trending video with creator info. Trending score
--      is computed inline (no precomputed column for videos yet):
--          score = views_count + likes_count * 5 + comments_count * 15
--      Filtered to videos created in last 7 days, status='published',
--      is_hidden=false. p_exclude_ids prevents repeating the same video
--      across consecutive injections in one session.
--
--   2. Update fetch_hybrid_feed slot-7 to alternate:
--      A cursor key `injection_alternator` flips 0/1 each injection.
--      Even → book_carousel. Odd → video_card. The alternator is read
--      from p_cursor (so it survives across pagination calls) and
--      written back to next_cursor.
--
-- Cross-session dedup arrays:
--      v_served_book_ids  — already existed, unchanged.
--      v_served_video_ids — NEW. Mirrors served_book_ids. The id of every
--                           video shown in any slot of this page goes in,
--                           passed to subsequent fetch_video_card calls so
--                           the same video never appears twice in one page.
--
-- Mobile changes (separate, in lib/posts-supabase.js):
--      enforceBookCarouselCadence treats any item with type in
--      {book_carousel, video_card} as an "injection" and keeps them at the
--      6-post cadence. Order is preserved (server already alternates), so
--      mobile just respects whatever order the server sent.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


-- ──────────────────────────────────────────────────────────────────
-- 1. fetch_video_card — trending video recommendation
-- ──────────────────────────────────────────────────────────────────
-- Returns a single video object wrapped in { video: {...} } for symmetry
-- with fetch_book_carousel's { books: [...] }. The wrapping matters because
-- the caller (fetch_hybrid_feed) checks the wrapped object for null/empty
-- before injecting — keeps the slot-7 branch's null handling consistent
-- across both injection types.
--
-- If no eligible video exists (e.g., empty videos table or all videos
-- already in p_exclude_ids), returns { video: null } rather than erroring.
-- The caller then skips this slot's injection and tries again next page.
create or replace function public.fetch_video_card(
  p_exclude_ids uuid[] default '{}'::uuid[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_used_ids uuid[] := coalesce(p_exclude_ids, '{}'::uuid[]);
  v_video    jsonb  := null;
  v_row      record;
begin
  -- One row, ranked by inline trending score. The +1 nudges to avoid
  -- division-by-zero confusion when comments_count is null on older rows.
  --
  -- Scoring weights mirror the creator_writer_rankings v3 formula
  -- (2026-05-08): comments weighted heaviest because a comment is the
  -- strongest signal of engagement; likes second; views as baseline.
  for v_row in (
    select
      v.id,
      v.title,
      v.thumbnail_url,
      v.video_url,
      v.duration,
      v.uploader_id,
      p.username      as uploader_username,
      p.display_name  as uploader_display_name,
      p.avatar_url    as uploader_avatar_url,
      coalesce(v.views_count, 0)    as views_count,
      coalesce(v.likes_count, 0)    as likes_count,
      coalesce(v.comments_count, 0) as comments_count,
      v.created_at
    from public.videos v
    left join public.profiles p on p.id = v.uploader_id
    where v.created_at > now() - interval '7 days'
      and coalesce(v.status, 'published') = 'published'
      and coalesce(v.is_hidden, false) = false
      and not (v.id = any(v_used_ids))
      -- Sanity guards — don't recommend a video missing its renderable
      -- assets. Cheap to check, prevents a broken card in the feed.
      and v.thumbnail_url is not null
      and v.video_url is not null
    order by
      (coalesce(v.views_count, 0)
        + coalesce(v.likes_count, 0) * 5
        + coalesce(v.comments_count, 0) * 15) desc,
      v.created_at desc,
      v.id
    limit 1
  ) loop
    v_video := jsonb_build_object(
      'id',                     v_row.id,
      'title',                  v_row.title,
      'thumbnail_url',          v_row.thumbnail_url,
      'video_url',              v_row.video_url,
      'duration',               v_row.duration,
      'uploader_id',            v_row.uploader_id,
      'uploader_username',      v_row.uploader_username,
      'uploader_display_name',  v_row.uploader_display_name,
      'uploader_avatar_url',    v_row.uploader_avatar_url,
      'views_count',            v_row.views_count,
      'likes_count',            v_row.likes_count,
      'comments_count',         v_row.comments_count
    );
  end loop;

  -- Backfill: if the strict 7-day window came up empty (small libraries
  -- of recent uploads), open the window to 30 days. Better to show a
  -- slightly older trending video than to silently skip the slot.
  if v_video is null then
    for v_row in (
      select
        v.id,
        v.title,
        v.thumbnail_url,
        v.video_url,
        v.duration,
        v.uploader_id,
        p.username      as uploader_username,
        p.display_name  as uploader_display_name,
        p.avatar_url    as uploader_avatar_url,
        coalesce(v.views_count, 0)    as views_count,
        coalesce(v.likes_count, 0)    as likes_count,
        coalesce(v.comments_count, 0) as comments_count
      from public.videos v
      left join public.profiles p on p.id = v.uploader_id
      where v.created_at > now() - interval '30 days'
        and coalesce(v.status, 'published') = 'published'
        and coalesce(v.is_hidden, false) = false
        and not (v.id = any(v_used_ids))
        and v.thumbnail_url is not null
        and v.video_url is not null
      order by
        (coalesce(v.views_count, 0)
          + coalesce(v.likes_count, 0) * 5
          + coalesce(v.comments_count, 0) * 15) desc,
        v.created_at desc,
        v.id
      limit 1
    ) loop
      v_video := jsonb_build_object(
        'id',                     v_row.id,
        'title',                  v_row.title,
        'thumbnail_url',          v_row.thumbnail_url,
        'video_url',              v_row.video_url,
        'duration',               v_row.duration,
        'uploader_id',            v_row.uploader_id,
        'uploader_username',      v_row.uploader_username,
        'uploader_display_name',  v_row.uploader_display_name,
        'uploader_avatar_url',    v_row.uploader_avatar_url,
        'views_count',            v_row.views_count,
        'likes_count',            v_row.likes_count,
        'comments_count',         v_row.comments_count
      );
    end loop;
  end if;

  return jsonb_build_object('video', v_video);
end;
$$;

revoke all on function public.fetch_video_card(uuid[]) from public;
grant execute on function public.fetch_video_card(uuid[]) to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────
-- 2. fetch_hybrid_feed — slot 7 alternates book_carousel ↔ video_card
-- ──────────────────────────────────────────────────────────────────
-- Changes vs. 2026-05-14_book_carousel_cross_dedup.sql:
--   • New cursor key `injection_alternator` (0/1). Read on entry,
--     incremented after each injection, written to next_cursor.
--   • New cursor key `video_card` mirroring `book_carousel` (just a
--     pull counter — we don't paginate inside the RPC since each call
--     emits at most 1 video).
--   • New v_served_video_ids array — passed to fetch_video_card on each
--     slot-7 injection so the same video doesn't appear twice in one page.
--   • Slot 7 branch now chooses book_carousel OR video_card based on
--     mod(v_cur_injection_alternator, 2). Even → book, odd → video.
--   • diagnostics + next_cursor extended with the new keys.

create or replace function public.fetch_hybrid_feed(
  p_user_id      uuid  default null,
  p_cursor       jsonb default '{}'::jsonb,
  p_limit        int   default 20,
  p_session_seed text  default null,
  p_creator_cap  int   default 2
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_target  int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_seed    text := coalesce(p_session_seed, '');
  v_cap     int  := greatest(1, coalesce(p_creator_cap, 2));

  v_items           jsonb  := '[]'::jsonb;
  v_served_post_ids uuid[] := '{}';
  v_served_creator_ids uuid[] := '{}';
  v_capped_creators uuid[] := '{}';
  v_served_book_ids uuid[] := '{}';
  v_served_video_ids uuid[] := '{}';  -- NEW: video_card cross-page dedup

  v_cur_fresh       int := coalesce((p_cursor->>'fresh')::int, 0);
  v_cur_engagement  int := coalesce((p_cursor->>'engagement')::int, 0);
  v_cur_exploration int := coalesce((p_cursor->>'exploration')::int, 0);
  v_cur_discussion  int := coalesce((p_cursor->>'discussion')::int, 0);
  v_cur_revived     int := coalesce((p_cursor->>'revived')::int, 0);
  v_cur_fallback    int := coalesce((p_cursor->>'fallback')::int, 0);
  v_cur_book_carousel int := coalesce((p_cursor->>'book_carousel')::int, 0);
  v_cur_video_card    int := coalesce((p_cursor->>'video_card')::int, 0);
  -- NEW: 0/1 toggle to alternate book ↔ video at slot 7 across the
  -- entire session (survives pagination via the cursor).
  v_cur_injection_alternator int := coalesce((p_cursor->>'injection_alternator')::int, 0);

  v_pull_fresh       int := 0;
  v_pull_engagement  int := 0;
  v_pull_exploration int := 0;
  v_pull_discussion  int := 0;
  v_pull_revived     int := 0;
  v_pull_fallback    int := 0;
  v_pull_book_carousel int := 0;
  v_pull_video_card  int := 0;  -- NEW

  v_slot     int;
  v_bucket   text;
  v_source   text;
  v_post_id  uuid;
  v_creator  uuid;
  v_creator_count int;

  v_carousel jsonb;
  v_carousel_books jsonb;
  v_book record;

  v_video_payload jsonb;
  v_video_inner   jsonb;
begin
  v_user_id := coalesce(public.current_profile_id(), p_user_id);

  if v_user_id is null then
    return jsonb_build_object(
      'items',       '[]'::jsonb,
      'next_cursor', p_cursor,
      'error',       'not_authenticated'
    );
  end if;

  while jsonb_array_length(v_items) < v_target loop

    v_slot := (jsonb_array_length(v_items) % 7) + 1;

    -- SLOT 7: alternating injection (book_carousel ↔ video_card)
    if v_slot = 7 then
      if mod(v_cur_injection_alternator, 2) = 0 then
        -- EVEN turn → BOOK CAROUSEL
        v_carousel := public.fetch_book_carousel(v_cur_book_carousel, v_served_book_ids);
        v_carousel_books := coalesce(v_carousel -> 'books', '[]'::jsonb);
        if v_carousel is not null and jsonb_array_length(v_carousel_books) >= 2 then
          for v_book in (
            select (elem ->> 'id')::uuid as book_id
              from jsonb_array_elements(v_carousel_books) elem
             where (elem ->> 'id') is not null
          ) loop
            v_served_book_ids := array_append(v_served_book_ids, v_book.book_id);
          end loop;

          v_items := v_items || jsonb_build_object(
            'type', 'book_carousel',
            'data', v_carousel
          );
          v_cur_book_carousel := v_cur_book_carousel + 4;
          v_pull_book_carousel := v_pull_book_carousel + 1;
          v_cur_injection_alternator := v_cur_injection_alternator + 1;
          continue;
        end if;
        -- Book carousel empty → fall through to video as a fallback,
        -- without advancing the alternator (so next slot 7 still tries
        -- book first). Prevents two video cards in a row when the book
        -- catalog is just sparse momentarily.

      else
        -- ODD turn → VIDEO CARD
        v_video_payload := public.fetch_video_card(v_served_video_ids);
        v_video_inner := v_video_payload -> 'video';
        if v_video_inner is not null and v_video_inner != 'null'::jsonb then
          v_served_video_ids := array_append(
            v_served_video_ids,
            (v_video_inner ->> 'id')::uuid
          );

          v_items := v_items || jsonb_build_object(
            'type', 'video_card',
            'data', v_video_inner
          );
          v_cur_video_card := v_cur_video_card + 1;
          v_pull_video_card := v_pull_video_card + 1;
          v_cur_injection_alternator := v_cur_injection_alternator + 1;
          continue;
        end if;
        -- Video card empty → fall through to book as a fallback (same
        -- reasoning as above but mirrored).
      end if;

      -- Either side fell through (no eligible content for the chosen
      -- type). Try the OTHER type as a one-shot fallback so we don't
      -- emit an empty slot. If both come up empty, the slot becomes a
      -- regular post via the v_bucket logic below.
      if mod(v_cur_injection_alternator, 2) = 0 then
        v_video_payload := public.fetch_video_card(v_served_video_ids);
        v_video_inner := v_video_payload -> 'video';
        if v_video_inner is not null and v_video_inner != 'null'::jsonb then
          v_served_video_ids := array_append(
            v_served_video_ids,
            (v_video_inner ->> 'id')::uuid
          );
          v_items := v_items || jsonb_build_object('type', 'video_card', 'data', v_video_inner);
          v_cur_video_card := v_cur_video_card + 1;
          v_pull_video_card := v_pull_video_card + 1;
          v_cur_injection_alternator := v_cur_injection_alternator + 1;
          continue;
        end if;
      else
        v_carousel := public.fetch_book_carousel(v_cur_book_carousel, v_served_book_ids);
        v_carousel_books := coalesce(v_carousel -> 'books', '[]'::jsonb);
        if v_carousel is not null and jsonb_array_length(v_carousel_books) >= 2 then
          for v_book in (
            select (elem ->> 'id')::uuid as book_id
              from jsonb_array_elements(v_carousel_books) elem
             where (elem ->> 'id') is not null
          ) loop
            v_served_book_ids := array_append(v_served_book_ids, v_book.book_id);
          end loop;
          v_items := v_items || jsonb_build_object('type', 'book_carousel', 'data', v_carousel);
          v_cur_book_carousel := v_cur_book_carousel + 4;
          v_pull_book_carousel := v_pull_book_carousel + 1;
          v_cur_injection_alternator := v_cur_injection_alternator + 1;
          continue;
        end if;
      end if;
    end if;

    v_bucket := case v_slot
      when 1 then 'fresh'
      when 2 then 'engagement'
      when 3 then 'exploration'
      when 4 then 'fallback'
      when 5 then 'discussion'
      when 6 then 'revived'
      when 7 then 'fallback'
    end;
    v_post_id := null;
    v_source  := null;

    if v_bucket = 'fresh' then
      select pfs.post_id into v_post_id
        from public.post_feed_scores pfs
        join public.posts p on p.id = pfs.post_id
       where 'fresh' = any(pfs.bucket_tags)
         and p.user_id != v_user_id
         and p.is_hidden = false
         and not (pfs.post_id = any(v_served_post_ids))
         and not (p.user_id = any(v_capped_creators))
         and not exists (
           select 1 from public.post_views pv
            where pv.user_id = v_user_id
              and pv.post_id = pfs.post_id
              and pv.viewed_at > now() - interval '24 hours'
         )
       order by pfs.freshness_score
                  * (0.85 + (mod(abs(hashtext(pfs.post_id::text || v_seed)), 30)) / 100.0)
                desc
       offset v_cur_fresh
       limit 1;
      if v_post_id is not null then
        v_cur_fresh := v_cur_fresh + 1;
        v_pull_fresh := v_pull_fresh + 1;
        v_source := 'fresh';
      end if;

    elsif v_bucket = 'engagement' then
      select pfs.post_id into v_post_id
        from public.post_feed_scores pfs
        join public.posts p on p.id = pfs.post_id
       where 'engagement' = any(pfs.bucket_tags)
         and p.user_id != v_user_id
         and p.is_hidden = false
         and not (pfs.post_id = any(v_served_post_ids))
         and not (p.user_id = any(v_capped_creators))
         and not exists (
           select 1 from public.post_views pv
            where pv.user_id = v_user_id
              and pv.post_id = pfs.post_id
              and pv.viewed_at > now() - interval '24 hours'
         )
       order by pfs.engagement_score
                  * (0.85 + (mod(abs(hashtext(pfs.post_id::text || v_seed)), 30)) / 100.0)
                desc
       offset v_cur_engagement
       limit 1;
      if v_post_id is not null then
        v_cur_engagement := v_cur_engagement + 1;
        v_pull_engagement := v_pull_engagement + 1;
        v_source := 'engagement';
      end if;

    elsif v_bucket = 'exploration' then
      select pfs.post_id into v_post_id
        from public.post_feed_scores pfs
        join public.posts p on p.id = pfs.post_id
       where 'exploration' = any(pfs.bucket_tags)
         and p.user_id != v_user_id
         and p.is_hidden = false
         and not (pfs.post_id = any(v_served_post_ids))
         and not (p.user_id = any(v_capped_creators))
         and not exists (
           select 1 from public.post_views pv
            where pv.user_id = v_user_id
              and pv.post_id = pfs.post_id
              and pv.viewed_at > now() - interval '24 hours'
         )
       order by pfs.exploration_score
                  * (0.85 + (mod(abs(hashtext(pfs.post_id::text || v_seed)), 30)) / 100.0)
                desc
       offset v_cur_exploration
       limit 1;
      if v_post_id is not null then
        v_cur_exploration := v_cur_exploration + 1;
        v_pull_exploration := v_pull_exploration + 1;
        v_source := 'exploration';
      end if;

    elsif v_bucket = 'discussion' then
      select pfs.post_id into v_post_id
        from public.post_feed_scores pfs
        join public.posts p on p.id = pfs.post_id
       where 'discussion' = any(pfs.bucket_tags)
         and p.user_id != v_user_id
         and p.is_hidden = false
         and not (pfs.post_id = any(v_served_post_ids))
         and not (p.user_id = any(v_capped_creators))
         and not exists (
           select 1 from public.post_views pv
            where pv.user_id = v_user_id
              and pv.post_id = pfs.post_id
              and pv.viewed_at > now() - interval '24 hours'
         )
       order by pfs.discussion_score
                  * (0.85 + (mod(abs(hashtext(pfs.post_id::text || v_seed)), 30)) / 100.0)
                desc
       offset v_cur_discussion
       limit 1;
      if v_post_id is not null then
        v_cur_discussion := v_cur_discussion + 1;
        v_pull_discussion := v_pull_discussion + 1;
        v_source := 'discussion';
      end if;

    elsif v_bucket = 'revived' then
      select pfs.post_id into v_post_id
        from public.post_feed_scores pfs
        join public.posts p on p.id = pfs.post_id
       where 'revived' = any(pfs.bucket_tags)
         and p.user_id != v_user_id
         and p.is_hidden = false
         and not (pfs.post_id = any(v_served_post_ids))
         and not (p.user_id = any(v_capped_creators))
         and not exists (
           select 1 from public.post_views pv
            where pv.user_id = v_user_id
              and pv.post_id = pfs.post_id
              and pv.viewed_at > now() - interval '24 hours'
         )
       order by pfs.total_score
                  * (0.85 + (mod(abs(hashtext(pfs.post_id::text || v_seed)), 30)) / 100.0)
                desc
       offset v_cur_revived
       limit 1;
      if v_post_id is not null then
        v_cur_revived := v_cur_revived + 1;
        v_pull_revived := v_pull_revived + 1;
        v_source := 'revived';
      end if;
    end if;

    if v_post_id is null then
      select pfs.post_id into v_post_id
        from public.post_feed_scores pfs
        join public.posts p on p.id = pfs.post_id
       where p.user_id != v_user_id
         and p.is_hidden = false
         and not (pfs.post_id = any(v_served_post_ids))
         and not (p.user_id = any(v_capped_creators))
         and not exists (
           select 1 from public.post_views pv
            where pv.user_id = v_user_id
              and pv.post_id = pfs.post_id
              and pv.viewed_at > now() - interval '24 hours'
         )
       order by pfs.total_score
                  * (0.85 + (mod(abs(hashtext(pfs.post_id::text || v_seed)), 30)) / 100.0)
                desc
       offset v_cur_fallback
       limit 1;
      if v_post_id is not null then
        v_cur_fallback := v_cur_fallback + 1;
        v_pull_fallback := v_pull_fallback + 1;
        v_source := 'fallback';
      end if;
    end if;

    exit when v_post_id is null;

    select user_id into v_creator from public.posts where id = v_post_id;
    v_served_post_ids := array_append(v_served_post_ids, v_post_id);
    if v_creator is not null then
      v_served_creator_ids := array_append(v_served_creator_ids, v_creator);
      v_creator_count := (
        select count(*) from unnest(v_served_creator_ids) cid where cid = v_creator
      );
      if v_creator_count >= v_cap and not (v_creator = any(v_capped_creators)) then
        v_capped_creators := array_append(v_capped_creators, v_creator);
      end if;
    end if;

    v_items := v_items || jsonb_build_object(
      'type',    'post',
      'post_id', v_post_id,
      'bucket',  v_source
    );
  end loop;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', jsonb_build_object(
      'fresh',                 v_cur_fresh,
      'engagement',            v_cur_engagement,
      'exploration',           v_cur_exploration,
      'discussion',            v_cur_discussion,
      'revived',               v_cur_revived,
      'fallback',              v_cur_fallback,
      'book_carousel',         v_cur_book_carousel,
      'video_card',            v_cur_video_card,
      'injection_alternator',  v_cur_injection_alternator
    ),
    'diagnostics', jsonb_build_object(
      'bucket_pulls', jsonb_build_object(
        'fresh',         v_pull_fresh,
        'engagement',    v_pull_engagement,
        'exploration',   v_pull_exploration,
        'discussion',    v_pull_discussion,
        'revived',       v_pull_revived,
        'fallback',      v_pull_fallback,
        'book_carousel', v_pull_book_carousel,
        'video_card',    v_pull_video_card
      ),
      'items_returned',  jsonb_array_length(v_items),
      'capped_creators', array_length(v_capped_creators, 1),
      'served_book_ids', array_length(v_served_book_ids, 1),
      'served_video_ids', array_length(v_served_video_ids, 1),
      'session_seed_len', length(v_seed)
    )
  );
end;
$$;

revoke all on function public.fetch_hybrid_feed(uuid, jsonb, int, text, int) from public;
grant execute on function public.fetch_hybrid_feed(uuid, jsonb, int, text, int) to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────
-- 3. Index for trending video lookup
-- ──────────────────────────────────────────────────────────────────
-- The video survey (2026-05-15) found no existing index supporting the
-- "trending in last 7 days" query. fetch_video_card filters on
-- created_at > now() - 7d and orders by an inline score expression. A
-- partial index on created_at narrows the seek; the order-by is handled
-- by a sort node which is fine for the small result set (limit 1).
--
-- Plain CREATE INDEX (NOT CONCURRENTLY) because we're inside a
-- transaction block. The videos table is small enough today that the
-- exclusive lock during build is negligible. If the table grows huge
-- in the future, run CREATE INDEX CONCURRENTLY for this name manually
-- outside any migration first, then drop+recreate inside any migration
-- that needs to reference it.
create index if not exists idx_videos_recent_published
  on public.videos (created_at desc)
  where status = 'published' and (is_hidden is null or is_hidden = false);


notify pgrst, 'reload schema';


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
-- 1. fetch_video_card returns a non-null video:
--    select public.fetch_video_card('{}'::uuid[]);
--
-- 2. Two consecutive calls return DIFFERENT videos when the first id is
--    excluded:
--    with first as (
--      select public.fetch_video_card('{}'::uuid[]) as resp
--    ),
--    first_id as (
--      select ((resp -> 'video') ->> 'id')::uuid as id from first
--    )
--    select public.fetch_video_card(array(select id from first_id));
--    -- The second call's video.id should NOT match first_id.id.
--
-- 3. fetch_hybrid_feed alternates types at slot 7. Expect first injection
--    = book_carousel, second = video_card, third = book_carousel ...
--    with feed as (
--      select public.fetch_hybrid_feed(
--        p_user_id => (select id from public.profiles where username = 'Avyannahlavelle' limit 1),
--        p_cursor => '{}'::jsonb,
--        p_limit => 28,
--        p_session_seed => 'video-alt-test'
--      ) as resp
--    )
--    select
--      ord,
--      item ->> 'type' as item_type
--      from feed,
--           jsonb_array_elements(resp -> 'items') with ordinality as t(item, ord)
--     where item ->> 'type' in ('book_carousel', 'video_card')
--     order by ord;
--    -- Expect rows alternating book_carousel / video_card.
-- ════════════════════════════════════════════════════════════════════════════
