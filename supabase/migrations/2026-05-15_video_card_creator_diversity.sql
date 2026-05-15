-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Video card creator diversity (Phase 5B follow-up)
--
-- Charles 2026-05-15: "If the creator shows on 1st set, don't let them
-- show on another set... I saw Dear Cham on the 1st-6th set."
--
-- Bug: fetch_video_card returns the next trending video by offset.
-- A creator with 6+ trending videos this week ends up in every video
-- card slot (offset 0..5 all map to the same creator's videos).
-- Other creators with 1-2 trending videos never get surfaced.
--
-- Fix: track served creator ids in the per-session cursor (mirrors the
-- already-persisted served_book_ids pattern, but at the CREATOR level
-- for videos since each card surfaces one video by one creator). After
-- emitting a video card, the uploader_id is appended to the cursor's
-- `served_video_creator_ids` array. fetch_video_card excludes any
-- video whose uploader_id is in that array.
--
-- Within-page video-id dedup (v_served_video_ids) stays as-is — it's
-- a defense-in-depth in case a single page somehow tries to emit two
-- cards (it shouldn't, but the array is cheap to maintain).
--
-- Session reset: when the mobile session resets (fresh_session every
-- 30 min, sign-out, or new day), the cursor is cleared in MMKV via
-- resetFeedSession() (lib/feed-session.js). The next call to
-- fetch_hybrid_feed receives an empty cursor, served_video_creator_ids
-- defaults to '{}', and the exclusion pool starts empty again.
--
-- Backfill on exhaustion: if every trending creator has already been
-- served this session, fetch_video_card returns null. fetch_hybrid_feed
-- then falls back to a book_carousel at that slot (the mutual fallback
-- shipped in 2026-05-15_video_card_injection.sql). The user always sees
-- SOMETHING in the injection slot, never a gap.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


-- ──────────────────────────────────────────────────────────────────
-- 1. fetch_video_card — add p_exclude_creator_ids
-- ──────────────────────────────────────────────────────────────────
-- Signature change: (int, uuid[]) → (int, uuid[], uuid[]).
-- Drop the old 2-arg form so PostgREST routes to the 3-arg version
-- unambiguously. Same routing approach used by the offset hotfix.
create or replace function public.fetch_video_card(
  p_offset             int    default 0,
  p_exclude_ids        uuid[] default '{}'::uuid[],
  p_exclude_creator_ids uuid[] default '{}'::uuid[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_used_ids     uuid[] := coalesce(p_exclude_ids, '{}'::uuid[]);
  v_used_creator uuid[] := coalesce(p_exclude_creator_ids, '{}'::uuid[]);
  v_offset       int    := greatest(0, coalesce(p_offset, 0));
  v_video        jsonb  := null;
  v_row          record;
begin
  -- Primary lookup: 7-day window, trending score.
  -- Both the video-id exclusion (within-page dedup) and the creator-id
  -- exclusion (cross-page fairness) apply. Either set being non-empty
  -- shrinks the pool but doesn't change query shape.
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
      and not (v.uploader_id = any(v_used_creator))
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

  -- Backfill: open window to 30 days if 7-day comes up empty. Same
  -- exclusions apply — we don't sacrifice diversity to widen the window.
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
        and not (v.uploader_id = any(v_used_creator))
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

-- Drop the prior 2-arg signature so PostgREST routes to the new 3-arg
-- version. Old 2-arg callers (only fetch_hybrid_feed, updated below)
-- would error on next call; safe because we update both atomically.
drop function if exists public.fetch_video_card(int, uuid[]);

revoke all on function public.fetch_video_card(int, uuid[], uuid[]) from public;
grant execute on function public.fetch_video_card(int, uuid[], uuid[]) to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────
-- 2. fetch_hybrid_feed — persist served_video_creator_ids across pages
-- ──────────────────────────────────────────────────────────────────
-- Single targeted CREATE OR REPLACE. The only changes:
--   • Read v_served_video_creator_ids from p_cursor on entry.
--   • Pass it to fetch_video_card on each video slot.
--   • Append the emitted video's uploader_id after each emit.
--   • Write the array back into next_cursor.
-- Everything else carries over byte-identical from the previous version.

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

  -- NEW: cross-page video-creator exclusion. Mobile sends back the array
  -- we returned on the previous next_cursor, so this grows over a
  -- session. Reset on fresh_session via mobile MMKV reset.
  v_served_video_creator_ids uuid[] := '{}';

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
  v_video_uploader uuid;
begin
  v_user_id := coalesce(public.current_profile_id(), p_user_id);

  if v_user_id is null then
    return jsonb_build_object(
      'items',       '[]'::jsonb,
      'next_cursor', p_cursor,
      'error',       'not_authenticated'
    );
  end if;

  -- Hydrate v_served_video_creator_ids from the incoming cursor. The
  -- mobile client doesn't manipulate this array — it just round-trips
  -- whatever the previous call's next_cursor said. JSONB stringified
  -- UUIDs get cast back to uuid[] here.
  if p_cursor ? 'served_video_creator_ids' then
    select coalesce(array_agg(value::text::uuid), '{}'::uuid[])
      into v_served_video_creator_ids
      from jsonb_array_elements_text(p_cursor->'served_video_creator_ids') value;
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
        -- VIDEO
        v_video_payload := public.fetch_video_card(
          v_cur_video_card,
          v_served_video_ids,
          v_served_video_creator_ids
        );
        v_video_inner := v_video_payload -> 'video';
        if v_video_inner is not null and v_video_inner != 'null'::jsonb then
          v_served_video_ids := array_append(
            v_served_video_ids,
            (v_video_inner ->> 'id')::uuid
          );
          v_video_uploader := (v_video_inner ->> 'uploader_id')::uuid;
          if v_video_uploader is not null
             and not (v_video_uploader = any(v_served_video_creator_ids))
          then
            v_served_video_creator_ids :=
              array_append(v_served_video_creator_ids, v_video_uploader);
          end if;
          v_items := v_items || jsonb_build_object('type', 'video_card', 'data', v_video_inner);
          v_cur_video_card := v_cur_video_card + 1;
          v_pull_video_card := v_pull_video_card + 1;
          v_cur_injection_alternator := v_cur_injection_alternator + 1;
          continue;
        end if;
      end if;

      -- One-shot mutual fallback when the preferred type came up empty.
      -- Same as before; the only addition is creator-id tracking on the
      -- video path.
      if mod(v_cur_injection_alternator, 2) = 0 then
        v_video_payload := public.fetch_video_card(
          v_cur_video_card,
          v_served_video_ids,
          v_served_video_creator_ids
        );
        v_video_inner := v_video_payload -> 'video';
        if v_video_inner is not null and v_video_inner != 'null'::jsonb then
          v_served_video_ids := array_append(
            v_served_video_ids,
            (v_video_inner ->> 'id')::uuid
          );
          v_video_uploader := (v_video_inner ->> 'uploader_id')::uuid;
          if v_video_uploader is not null
             and not (v_video_uploader = any(v_served_video_creator_ids))
          then
            v_served_video_creator_ids :=
              array_append(v_served_video_creator_ids, v_video_uploader);
          end if;
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
      'fresh',                     v_cur_fresh,
      'engagement',                v_cur_engagement,
      'exploration',               v_cur_exploration,
      'discussion',                v_cur_discussion,
      'revived',                   v_cur_revived,
      'fallback',                  v_cur_fallback,
      'book_carousel',             v_cur_book_carousel,
      'video_card',                v_cur_video_card,
      'injection_alternator',      v_cur_injection_alternator,
      -- NEW: cross-page creator exclusion. Serialize the uuid array as
      -- a JSONB array of strings; mobile round-trips it untouched.
      'served_video_creator_ids',  to_jsonb(v_served_video_creator_ids)
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
      -- Diagnostic: how many distinct creators have we now excluded.
      -- Watch this grow over the session and confirm it caps near the
      -- size of your trending-creator pool.
      'served_video_creator_count', array_length(v_served_video_creator_ids, 1),
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
-- 1. fetch_video_card now accepts the 3-arg form and excludes creators:
--
--    -- First call: no exclusions, returns top trending video.
--    select (public.fetch_video_card(0, '{}'::uuid[], '{}'::uuid[]) -> 'video')
--           ->> 'uploader_username' as creator_1;
--
--    -- Exclude that creator → returns a DIFFERENT creator's video.
--    with first as (
--      select public.fetch_video_card(0, '{}'::uuid[], '{}'::uuid[]) as resp
--    ),
--    first_creator as (
--      select ((resp -> 'video') ->> 'uploader_id')::uuid as id from first
--    )
--    select (public.fetch_video_card(0, '{}'::uuid[],
--                                    array(select id from first_creator))
--            -> 'video') ->> 'uploader_username' as creator_2;
--
--    -- creator_1 and creator_2 should be DIFFERENT.
--
-- 2. fetch_hybrid_feed: every video_card slot across pages 1-5 should
--    surface a DIFFERENT creator. Run this to confirm:
--
--    do $$
--    declare
--      v_user uuid := (select id from public.profiles where username = 'Avyannahlavelle' limit 1);
--      v_cursor jsonb := '{}'::jsonb;
--      v_page jsonb;
--      v_creators text[] := '{}';
--    begin
--      for i in 1..5 loop
--        v_page := public.fetch_hybrid_feed(v_user, v_cursor, 15, 'creator-div-test');
--        v_cursor := v_page -> 'next_cursor';
--        for v_row in
--          select item -> 'data' ->> 'uploader_username' as username
--            from jsonb_array_elements(v_page -> 'items') item
--           where item ->> 'type' = 'video_card'
--        loop
--          v_creators := array_append(v_creators, v_row.username);
--        end loop;
--      end loop;
--      raise notice 'Video card creators across 5 pages: %', v_creators;
--      raise notice 'Distinct creator count: %', (
--        select count(distinct unnest) from unnest(v_creators)
--      );
--    end$$;
--
--    Expect: 5 distinct creators (or as many as the trending pool has;
--    if fewer than 5 unique creators exist, you'll see the array shorter).
-- ════════════════════════════════════════════════════════════════════════════
