-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Book carousel author diversity
--
-- Charles 2026-05-15: "I kept seeing imagination ni ate on 1 carousel, on
-- all set. 1 author per carousel and cannot be seen again on 1st to 5th
-- set. Let's give chance to the others."
--
-- Two bugs, both about author fairness:
--
--   BUG 1 (within-carousel): The 10-book carousel picks 2-4 books from
--   each of 4 roles (trending / newly_updated / low_visibility /
--   high_engagement). Each role's SELECT runs independently. If author
--   X has books in two roles, two of the carousel's 10 slots end up as
--   author X — same face, twice, in the same carousel.
--
--   BUG 2 (cross-carousel): The next carousel call shares no author state
--   with the previous one. If "Imagination ni Ate" was trending #1 last
--   carousel and is STILL #1 this carousel, they get served again. And
--   again. Author X's other books get surfaced repeatedly while authors
--   Y/Z/W/... never appear.
--
-- Fix mirrors the video card creator diversity migration:
--   • fetch_book_carousel gains p_exclude_author_ids uuid[]. Each role's
--     SELECT adds `and not (b.author_id = any(v_used_author_ids))`.
--     Within the function, v_used_author_ids accumulates with each book
--     emitted, so subsequent roles can't pick the same author.
--   • fetch_hybrid_feed persists served_book_author_ids in the cursor
--     (mirrors served_video_creator_ids). After each carousel, the
--     author_ids of all 10 books are appended. Next page's carousel
--     call excludes them.
--   • Session reset (fresh_session via mobile MMKV reset) clears the
--     cursor and the author exclusion pool starts over.
--
-- Backfill on exhaustion: if every author with eligible books has been
-- served this session, the carousel falls back to its existing backfill
-- (trending books with author exclusion relaxed). Better to show some
-- repeats than an empty carousel slot.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


-- ──────────────────────────────────────────────────────────────────
-- 1. fetch_book_carousel — add p_exclude_author_ids + within-carousel uniqueness
-- ──────────────────────────────────────────────────────────────────
-- Signature change: (int, uuid[]) → (int, uuid[], uuid[]).
-- Drop the old 2-arg form so PostgREST routes to the 3-arg version.
create or replace function public.fetch_book_carousel(
  p_offset             int    default 0,
  p_exclude_ids        uuid[] default '{}'::uuid[],
  p_exclude_author_ids uuid[] default '{}'::uuid[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_used_ids        uuid[] := coalesce(p_exclude_ids, '{}'::uuid[]);
  -- Cross-carousel author exclusion (session-wide) seeded from caller,
  -- then grown locally with every book we emit. The same array does
  -- double duty for within-carousel uniqueness — after picking a book
  -- for the trending role, that author is excluded from the
  -- newly_updated / low_visibility / high_engagement role queries too.
  v_used_author_ids uuid[] := coalesce(p_exclude_author_ids, '{}'::uuid[]);
  v_books           jsonb  := '[]'::jsonb;
  v_offset          int    := greatest(0, coalesce(p_offset, 0));
  v_row             record;
  v_added           int;
begin

  -- Positions 1-4: TRENDING
  v_added := 0;
  for v_row in (
    select b.id, b.title, b.cover_url, b.author_id,
           p.username      as author_username,
           p.display_name  as author_display_name,
           p.avatar_url    as author_avatar_url,
           b.ratings_avg,
           b.ratings_count,
           b.views_count
      from public.books b
      left join public.profiles p on p.id = b.author_id
     where b.is_public = true
       and b.is_hidden = false
       and b.status in ('ongoing', 'completed')
       and not (b.id = any(v_used_ids))
       and not (b.author_id = any(v_used_author_ids))
     order by b.trending_score desc nulls last, b.id
     offset v_offset
     limit 15
  ) loop
    v_used_ids := array_append(v_used_ids, v_row.id);
    if v_row.author_id is not null then
      v_used_author_ids := array_append(v_used_author_ids, v_row.author_id);
    end if;
    v_books := v_books || jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'cover_url', v_row.cover_url,
      'author_id', v_row.author_id,
      'author_username', v_row.author_username,
      'author_display_name', v_row.author_display_name,
      'author_avatar_url', v_row.author_avatar_url,
      'ratings_avg', v_row.ratings_avg,
      'ratings_count', v_row.ratings_count,
      'role', 'trending'
    );
    v_added := v_added + 1;
    exit when v_added >= 4;
  end loop;

  -- Positions 5-6: NEWLY UPDATED
  v_added := 0;
  for v_row in (
    select b.id, b.title, b.cover_url, b.author_id,
           p.username      as author_username,
           p.display_name  as author_display_name,
           p.avatar_url    as author_avatar_url,
           b.ratings_avg,
           b.ratings_count,
           b.views_count
      from public.books b
      left join public.profiles p on p.id = b.author_id
     where b.is_public = true
       and b.is_hidden = false
       and b.status in ('ongoing', 'completed')
       and b.updated_at > now() - interval '30 days'
       and not (b.id = any(v_used_ids))
       and not (b.author_id = any(v_used_author_ids))
     order by b.updated_at desc nulls last, b.id
     limit 10
  ) loop
    v_used_ids := array_append(v_used_ids, v_row.id);
    if v_row.author_id is not null then
      v_used_author_ids := array_append(v_used_author_ids, v_row.author_id);
    end if;
    v_books := v_books || jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'cover_url', v_row.cover_url,
      'author_id', v_row.author_id,
      'author_username', v_row.author_username,
      'author_display_name', v_row.author_display_name,
      'author_avatar_url', v_row.author_avatar_url,
      'ratings_avg', v_row.ratings_avg,
      'ratings_count', v_row.ratings_count,
      'role', 'newly_updated'
    );
    v_added := v_added + 1;
    exit when v_added >= 2;
  end loop;

  -- Positions 7-8: LOW VISIBILITY
  v_added := 0;
  for v_row in (
    select b.id, b.title, b.cover_url, b.author_id,
           p.username      as author_username,
           p.display_name  as author_display_name,
           p.avatar_url    as author_avatar_url,
           b.ratings_avg,
           b.ratings_count,
           b.views_count
      from public.books b
      left join public.profiles p on p.id = b.author_id
     where b.is_public = true
       and b.is_hidden = false
       and b.status in ('ongoing', 'completed')
       and coalesce(b.views_count, 0) < 1000
       and coalesce(b.ratings_count, 0) >= 3
       and not (b.id = any(v_used_ids))
       and not (b.author_id = any(v_used_author_ids))
     order by b.ratings_avg desc nulls last,
              b.likes_count desc nulls last,
              b.id
     limit 10
  ) loop
    v_used_ids := array_append(v_used_ids, v_row.id);
    if v_row.author_id is not null then
      v_used_author_ids := array_append(v_used_author_ids, v_row.author_id);
    end if;
    v_books := v_books || jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'cover_url', v_row.cover_url,
      'author_id', v_row.author_id,
      'author_username', v_row.author_username,
      'author_display_name', v_row.author_display_name,
      'author_avatar_url', v_row.author_avatar_url,
      'ratings_avg', v_row.ratings_avg,
      'ratings_count', v_row.ratings_count,
      'role', 'low_visibility'
    );
    v_added := v_added + 1;
    exit when v_added >= 2;
  end loop;

  -- Positions 9-10: HIGH ENGAGEMENT
  v_added := 0;
  for v_row in (
    select b.id, b.title, b.cover_url, b.author_id,
           p.username      as author_username,
           p.display_name  as author_display_name,
           p.avatar_url    as author_avatar_url,
           b.ratings_avg,
           b.ratings_count,
           b.views_count
      from public.books b
      left join public.profiles p on p.id = b.author_id
     where b.is_public = true
       and b.is_hidden = false
       and b.status in ('ongoing', 'completed')
       and coalesce(b.views_count, 0) > 100
       and not (b.id = any(v_used_ids))
       and not (b.author_id = any(v_used_author_ids))
     order by (b.likes_count::float / nullif(b.views_count, 0)) desc nulls last,
              b.ratings_avg desc nulls last,
              b.id
     limit 10
  ) loop
    v_used_ids := array_append(v_used_ids, v_row.id);
    if v_row.author_id is not null then
      v_used_author_ids := array_append(v_used_author_ids, v_row.author_id);
    end if;
    v_books := v_books || jsonb_build_object(
      'id', v_row.id,
      'title', v_row.title,
      'cover_url', v_row.cover_url,
      'author_id', v_row.author_id,
      'author_username', v_row.author_username,
      'author_display_name', v_row.author_display_name,
      'author_avatar_url', v_row.author_avatar_url,
      'ratings_avg', v_row.ratings_avg,
      'ratings_count', v_row.ratings_count,
      'role', 'high_engagement'
    );
    v_added := v_added + 1;
    exit when v_added >= 2;
  end loop;

  -- Backfill — pad with additional trending books if any role came up
  -- empty after the exclude filters. Author exclusion stays strict here
  -- too: we'd rather show 8 unique-author books than 10 with repeats.
  v_added := jsonb_array_length(v_books);
  if v_added < 10 then
    for v_row in (
      select b.id, b.title, b.cover_url, b.author_id,
             p.username      as author_username,
             p.display_name  as author_display_name,
             p.avatar_url    as author_avatar_url,
             b.ratings_avg,
             b.ratings_count,
             b.views_count
        from public.books b
        left join public.profiles p on p.id = b.author_id
       where b.is_public = true
         and b.is_hidden = false
         and b.status in ('ongoing', 'completed')
         and not (b.id = any(v_used_ids))
         and not (b.author_id = any(v_used_author_ids))
       order by b.trending_score desc nulls last, b.id
       limit 30
    ) loop
      v_used_ids := array_append(v_used_ids, v_row.id);
      if v_row.author_id is not null then
        v_used_author_ids := array_append(v_used_author_ids, v_row.author_id);
      end if;
      v_books := v_books || jsonb_build_object(
        'id', v_row.id,
        'title', v_row.title,
        'cover_url', v_row.cover_url,
        'author_id', v_row.author_id,
        'author_username', v_row.author_username,
        'author_display_name', v_row.author_display_name,
        'author_avatar_url', v_row.author_avatar_url,
        'ratings_avg', v_row.ratings_avg,
        'ratings_count', v_row.ratings_count,
        'role', 'trending'
      );
      v_added := v_added + 1;
      exit when v_added >= 10;
    end loop;
  end if;

  return jsonb_build_object('books', v_books);
end;
$$;

-- Drop the prior 2-arg signature so PostgREST routes to the new 3-arg
-- version unambiguously. fetch_hybrid_feed is updated below to call
-- the new signature.
drop function if exists public.fetch_book_carousel(int, uuid[]);

revoke all on function public.fetch_book_carousel(int, uuid[], uuid[]) from public;
grant execute on function public.fetch_book_carousel(int, uuid[], uuid[]) to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────
-- 2. fetch_hybrid_feed — persist served_book_author_ids across pages
-- ──────────────────────────────────────────────────────────────────
-- Single targeted CREATE OR REPLACE. The only changes:
--   • Read v_served_book_author_ids from p_cursor on entry.
--   • Pass it to fetch_book_carousel on each book slot (both primary
--     and the mutual-fallback path).
--   • Append each book's author_id from the returned carousel to the
--     accumulating array.
--   • Write the array back into next_cursor.
-- Everything else is identical to the previous version (which already
-- handled served_video_creator_ids the same way).

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
  v_served_video_creator_ids uuid[] := '{}';
  -- NEW: cross-page author exclusion for book carousels. Mirrors
  -- served_video_creator_ids semantics.
  v_served_book_author_ids uuid[] := '{}';

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

  -- Hydrate cross-page exclusion arrays from the incoming cursor. JSON
  -- arrays of UUID strings → uuid[]. Both arrays grow over the session
  -- and reset when mobile clears the cursor (fresh_session).
  if p_cursor ? 'served_video_creator_ids' then
    select coalesce(array_agg(value::text::uuid), '{}'::uuid[])
      into v_served_video_creator_ids
      from jsonb_array_elements_text(p_cursor->'served_video_creator_ids') value;
  end if;

  if p_cursor ? 'served_book_author_ids' then
    select coalesce(array_agg(value::text::uuid), '{}'::uuid[])
      into v_served_book_author_ids
      from jsonb_array_elements_text(p_cursor->'served_book_author_ids') value;
  end if;

  while jsonb_array_length(v_items) < v_target loop

    v_slot := (jsonb_array_length(v_items) % 7) + 1;

    if v_slot = 7 then
      if mod(v_cur_injection_alternator, 2) = 0 then
        -- BOOK — pass both the within-page book-id exclusion AND the
        -- cross-page author exclusion. fetch_book_carousel enforces
        -- within-carousel author uniqueness on top of these.
        v_carousel := public.fetch_book_carousel(
          v_cur_book_carousel,
          v_served_book_ids,
          v_served_book_author_ids
        );
        v_carousel_books := coalesce(v_carousel -> 'books', '[]'::jsonb);
        if v_carousel is not null and jsonb_array_length(v_carousel_books) >= 2 then
          for v_book in (
            select (elem ->> 'id')::uuid        as book_id,
                   (elem ->> 'author_id')::uuid as author_id
              from jsonb_array_elements(v_carousel_books) elem
             where (elem ->> 'id') is not null
          ) loop
            v_served_book_ids := array_append(v_served_book_ids, v_book.book_id);
            if v_book.author_id is not null
               and not (v_book.author_id = any(v_served_book_author_ids))
            then
              v_served_book_author_ids :=
                array_append(v_served_book_author_ids, v_book.author_id);
            end if;
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

      -- Mutual fallback when the preferred type came up empty. Same
      -- exclusion arrays apply to keep fairness consistent across the
      -- fallback path.
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
        v_carousel := public.fetch_book_carousel(
          v_cur_book_carousel,
          v_served_book_ids,
          v_served_book_author_ids
        );
        v_carousel_books := coalesce(v_carousel -> 'books', '[]'::jsonb);
        if v_carousel is not null and jsonb_array_length(v_carousel_books) >= 2 then
          for v_book in (
            select (elem ->> 'id')::uuid        as book_id,
                   (elem ->> 'author_id')::uuid as author_id
              from jsonb_array_elements(v_carousel_books) elem
             where (elem ->> 'id') is not null
          ) loop
            v_served_book_ids := array_append(v_served_book_ids, v_book.book_id);
            if v_book.author_id is not null
               and not (v_book.author_id = any(v_served_book_author_ids))
            then
              v_served_book_author_ids :=
                array_append(v_served_book_author_ids, v_book.author_id);
            end if;
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
      'served_video_creator_ids',  to_jsonb(v_served_video_creator_ids),
      'served_book_author_ids',    to_jsonb(v_served_book_author_ids)
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
      'served_video_creator_count', array_length(v_served_video_creator_ids, 1),
      'served_book_author_count', array_length(v_served_book_author_ids, 1),
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
-- 1. Within-carousel author uniqueness: a single fetch_book_carousel call
--    should return 10 books with 10 DISTINCT author_ids.
--
--    with c as (
--      select public.fetch_book_carousel(0, '{}'::uuid[], '{}'::uuid[]) as resp
--    )
--    select
--      count(*) as total_books,
--      count(distinct (book ->> 'author_id')) as distinct_authors
--    from c, jsonb_array_elements(resp -> 'books') book;
--
--    Expect: total_books = distinct_authors (10 = 10, or 8 = 8 if pool sparse).
--
-- 2. Cross-page author diversity: 5 consecutive carousel calls in one
--    session should yield 0 author overlap.
--
--    do $$
--    declare
--      v_used uuid[] := '{}';
--      v_offset int := 0;
--      v_resp jsonb;
--      v_dupes int := 0;
--    begin
--      for i in 1..5 loop
--        v_resp := public.fetch_book_carousel(v_offset, '{}'::uuid[], v_used);
--        for v_row in (
--          select (book ->> 'author_id')::uuid as author_id
--            from jsonb_array_elements(v_resp -> 'books') book
--           where (book ->> 'author_id') is not null
--        ) loop
--          if v_row.author_id = any(v_used) then
--            v_dupes := v_dupes + 1;
--          end if;
--          v_used := array_append(v_used, v_row.author_id);
--        end loop;
--        v_offset := v_offset + 4;
--      end loop;
--      raise notice 'Total author duplicates across 5 carousels: %', v_dupes;
--    end$$;
--
--    Expect: 'Total author duplicates across 5 carousels: 0'
-- ════════════════════════════════════════════════════════════════════════════
