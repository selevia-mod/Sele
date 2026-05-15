-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — fetch_hybrid_feed cross-page post dedup
--
-- Bug observed during Phase 5B testing: every page returned ~13 posts
-- but mobile's dedup pass stripped 5-7 of them as duplicates against
-- cachedPosts. Logs showed `incoming=15 → unique=8` repeatedly.
--
-- Root cause: v_served_post_ids was a local-only variable. Each
-- fetch_hybrid_feed call started with v_served_post_ids = '{}', so
-- posts already emitted on page 1 had nothing stopping them from being
-- re-emitted on page 2. The fallback bucket especially recycled the
-- same top-scored posts every page because:
--   • v_cur_fallback offset advances but doesn't account for posts
--     filtered out by other exclusions.
--   • Real-time post_views tracking from mobile has a small lag
--     window where a post is "served but not yet marked viewed."
--
-- Why this matters: mobile masks the dupes via filterUniqueFeedItems,
-- so users don't see them — BUT the dedup happens AFTER fetch +
-- hydration + safety filter + cadence, wasting DB bandwidth and
-- shrinking the page's effective post count. Real feed depth was
-- ~50% of nominal.
--
-- Fix: persist a rolling window of served post ids in the cursor.
-- Hydrate v_served_post_ids from the incoming cursor; after each
-- emission, trim to the last 60 ids (3 pages × 20 items) so the
-- cursor JSON doesn't grow unbounded. The trim is a sliding window —
-- ids that fall out have almost certainly been recorded in
-- post_views by then, so the 24h view filter takes over.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


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
  -- Cross-page rolling window — hydrated from p_cursor.served_post_ids
  -- and trimmed to the last 60 ids before returning. The trim happens
  -- in next_cursor construction at the bottom of the function.
  v_served_post_ids uuid[] := '{}';
  v_served_creator_ids uuid[] := '{}';
  v_capped_creators uuid[] := '{}';
  v_served_book_ids uuid[] := '{}';
  v_served_video_ids uuid[] := '{}';
  v_served_video_creator_ids uuid[] := '{}';
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

  -- Cursor-size cap. 60 ids ≈ 3 pages of 20 items. After 3 pages an
  -- old id falls out of the window; by then mobile's post_views ping
  -- has almost certainly registered, so the 24h view filter catches
  -- any genuine re-emission attempts. 60 × 36-char UUIDs ≈ 2.2KB JSON.
  v_post_dedup_window_size int := 60;
begin
  v_user_id := coalesce(public.current_profile_id(), p_user_id);

  if v_user_id is null then
    return jsonb_build_object(
      'items',       '[]'::jsonb,
      'next_cursor', p_cursor,
      'error',       'not_authenticated'
    );
  end if;

  -- Hydrate the cross-page arrays from the incoming cursor. Each is a
  -- JSON array of UUID strings; cast back to uuid[] via
  -- jsonb_array_elements_text.
  if p_cursor ? 'served_post_ids' then
    select coalesce(array_agg(value::text::uuid), '{}'::uuid[])
      into v_served_post_ids
      from jsonb_array_elements_text(p_cursor->'served_post_ids') value;
  end if;

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
        -- BOOK
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

      -- Mutual fallback when the preferred type came up empty.
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
      'served_book_author_ids',    to_jsonb(v_served_book_author_ids),
      -- Sliding window of recently-served post ids. Trim from the
      -- front (oldest) so the most recent v_post_dedup_window_size
      -- entries survive. Older ids that fall out have, by then, almost
      -- certainly been registered in post_views by the mobile view-
      -- tracker, so the 24h view filter takes over for them.
      'served_post_ids',           to_jsonb(
        (
          select coalesce(array_agg(x order by ord), '{}'::uuid[])
            from (
              select x, ord
                from unnest(v_served_post_ids) with ordinality as t(x, ord)
               order by ord desc
               limit v_post_dedup_window_size
            ) recent
        )
      )
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
      'served_post_count', array_length(v_served_post_ids, 1),
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
-- Two consecutive paginated calls should return DISJOINT post_id sets.
--
-- do $$
-- declare
--   v_user uuid := (select id from public.profiles where username = 'Avyannahlavelle' limit 1);
--   v_page1 jsonb;
--   v_page2 jsonb;
--   v_overlap int;
-- begin
--   v_page1 := public.fetch_hybrid_feed(v_user, '{}'::jsonb, 15, 'fallback-dedup-test');
--   v_page2 := public.fetch_hybrid_feed(v_user, v_page1 -> 'next_cursor', 15, 'fallback-dedup-test');
--
--   select count(*)::int into v_overlap
--     from jsonb_array_elements(v_page1 -> 'items') p1
--     join jsonb_array_elements(v_page2 -> 'items') p2
--       on (p1 ->> 'post_id') = (p2 ->> 'post_id')
--     where (p1 ->> 'post_id') is not null;
--
--   raise notice 'Posts shared between page 1 and page 2: %', v_overlap;
--   raise notice 'Page 2 next_cursor served_post_ids length: %', (
--     jsonb_array_length((v_page2 -> 'next_cursor') -> 'served_post_ids')
--   );
-- end$$;
--
-- Expect: 'Posts shared between page 1 and page 2: 0'
-- Expect: served_post_ids array growing each page, capped at 60.
-- ════════════════════════════════════════════════════════════════════════════
