-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Video card cross-page offset hotfix
--
-- Bug found same day Phase 5B shipped: the 2nd "Video for you" slot in the
-- visible feed was being replaced by a duplicate book carousel. Trace:
--
--   1. fetch_video_card had no p_offset parameter — it always returned the
--      single top-trending video.
--   2. fetch_hybrid_feed called fetch_video_card(v_served_video_ids), but
--      v_served_video_ids is a LOCAL variable that resets every call.
--   3. So page 1's call and page 2's call both got the same trending
--      video back.
--   4. Mobile's filterUniqueFeedItems dedupes by `video_card-${videoId}`
--      key. Same id → same key → page 2's video gets stripped.
--   5. The cadence enforcer's queue for page 2 ends up [book] only
--      (video dropped during dedup), so where the user expected a video
--      they see "3 more posts, then a book" — book takes the slot that
--      should have been video.
--
-- Fix mirrors what fetch_book_carousel already does:
--   • Add a p_offset parameter to fetch_video_card. Used as OFFSET in
--     the trending ORDER BY. Page 1 calls with offset 0, page 2 with
--     offset 1, page 3 with offset 2, etc.
--   • Increment v_cur_video_card in fetch_hybrid_feed each time a video
--     card is emitted. The cursor key already exists from the Phase 5B
--     migration; it was just unused for fetching.
--   • Pass v_cur_video_card as p_offset on the video fetch call.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


-- ──────────────────────────────────────────────────────────────────
-- 1. fetch_video_card — add p_offset
-- ──────────────────────────────────────────────────────────────────
-- Drops the single-arg signature first (PostgREST routes by exact
-- signature). The 2-arg version takes precedence; no callers use the
-- 1-arg form except fetch_hybrid_feed which we update below.
create or replace function public.fetch_video_card(
  p_offset      int    default 0,
  p_exclude_ids uuid[] default '{}'::uuid[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_used_ids uuid[] := coalesce(p_exclude_ids, '{}'::uuid[]);
  v_offset   int    := greatest(0, coalesce(p_offset, 0));
  v_video    jsonb  := null;
  v_row      record;
begin
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
    where v.created_at > now() - interval '7 days'
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
    offset v_offset
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

  -- Backfill: if 7-day window came up empty (sparse recent uploads),
  -- open to 30 days. Same offset semantics so cross-page advancement
  -- still works.
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
      offset v_offset
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

-- Drop the old 1-arg signature so PostgREST routes new callers to the
-- 2-arg version unambiguously. Same approach as the book carousel
-- offset migration on 2026-05-14.
drop function if exists public.fetch_video_card(uuid[]);

revoke all on function public.fetch_video_card(int, uuid[]) from public;
grant execute on function public.fetch_video_card(int, uuid[]) to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────
-- 2. fetch_hybrid_feed — pass v_cur_video_card as the offset
-- ──────────────────────────────────────────────────────────────────
-- Single targeted CREATE OR REPLACE. Only the slot-7 video_card branch
-- changes (call signature + offset arg). Everything else carried over
-- byte-identical from 2026-05-15_video_card_injection.sql.

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
  v_served_video_ids uuid[] := '{}';

  v_cur_fresh       int := coalesce((p_cursor->>'fresh')::int, 0);
  v_cur_engagement  int := coalesce((p_cursor->>'engagement')::int, 0);
  v_cur_exploration int := coalesce((p_cursor->>'exploration')::int, 0);
  v_cur_discussion  int := coalesce((p_cursor->>'discussion')::int, 0);
  v_cur_revived     int := coalesce((p_cursor->>'revived')::int, 0);
  v_cur_fallback    int := coalesce((p_cursor->>'fallback')::int, 0);
  v_cur_book_carousel int := coalesce((p_cursor->>'book_carousel')::int, 0);
  v_cur_video_card    int := coalesce((p_cursor->>'video_card')::int, 0);
  v_cur_injection_alternator int := coalesce((p_cursor->>'injection_alternator')::int, 0);

  v_pull_fresh       int := 0;
  v_pull_engagement  int := 0;
  v_pull_exploration int := 0;
  v_pull_discussion  int := 0;
  v_pull_revived     int := 0;
  v_pull_fallback    int := 0;
  v_pull_book_carousel int := 0;
  v_pull_video_card  int := 0;

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

    if v_slot = 7 then
      if mod(v_cur_injection_alternator, 2) = 0 then
        -- BOOK
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
      else
        -- VIDEO — now passes v_cur_video_card as the offset so different
        -- videos appear across pages (cross-page dedup fix 2026-05-15).
        v_video_payload := public.fetch_video_card(v_cur_video_card, v_served_video_ids);
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
      end if;

      -- One-shot fallback to the OTHER injection type when the preferred
      -- type came up empty. Mutually mirrored from the block above so a
      -- truly-empty pool doesn't leave slot 7 staring at nothing — we
      -- emit whatever's available, accept that the alternation pattern
      -- has a one-slot hiccup, and resume on the next slot 7.
      if mod(v_cur_injection_alternator, 2) = 0 then
        v_video_payload := public.fetch_video_card(v_cur_video_card, v_served_video_ids);
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


notify pgrst, 'reload schema';


commit;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
-- 1. fetch_video_card(0, '{}') and fetch_video_card(1, '{}') return
--    DIFFERENT videos (assuming there are at least 2 eligible).
--
--    select
--      (public.fetch_video_card(0, '{}'::uuid[]) -> 'video' ->> 'id') as offset_0_id,
--      (public.fetch_video_card(1, '{}'::uuid[]) -> 'video' ->> 'id') as offset_1_id;
--
-- 2. Two consecutive fetch_hybrid_feed calls (page 1, then page 2 using
--    page 1's next_cursor) yield DIFFERENT video ids in the slot-7 emits.
--
--    do $$
--    declare
--      v_user uuid := (select id from public.profiles where username = 'Avyannahlavelle' limit 1);
--      v_page1 jsonb;
--      v_page2 jsonb;
--    begin
--      v_page1 := public.fetch_hybrid_feed(v_user, '{}'::jsonb, 15, 'video-offset-test');
--      v_page2 := public.fetch_hybrid_feed(v_user, v_page1 -> 'next_cursor', 15, 'video-offset-test');
--      raise notice 'page 1 video ids: %', (
--        select jsonb_agg(item -> 'data' ->> 'id')
--        from jsonb_array_elements(v_page1 -> 'items') item
--        where item ->> 'type' = 'video_card'
--      );
--      raise notice 'page 2 video ids: %', (
--        select jsonb_agg(item -> 'data' ->> 'id')
--        from jsonb_array_elements(v_page2 -> 'items') item
--        where item ->> 'type' = 'video_card'
--      );
--    end$$;
--
--    Expect the two NOTICE outputs to have NO ids in common.
-- ════════════════════════════════════════════════════════════════════════════
