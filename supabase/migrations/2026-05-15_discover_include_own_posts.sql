-- ════════════════════════════════════════════════════════════════════════════
-- Discover: stop excluding the viewer's own posts
-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15. Product decision: Discover should surface the latest posts
-- across the platform, including the viewer's own. Original feed_discover_v2
-- hard-excluded `p.user_id <> p_user_id` so creators couldn't see how their
-- own posts ranked in the algorithmic mix. Charles wants the inverse:
-- Discover = "what's hot right now," own posts allowed in the pool.
--
-- The view-debounce (`not exists post_views in last 3 days`) at the bottom
-- of the function still applies, so once you've seen your own post you
-- won't keep seeing it repeat in Discover — it'll surface, then dedupe.
--
-- This is a one-line change inside the existing function. Everything else
-- about scoring (new_creator + virality + subgenre_drama + trending_video
-- + new_writer + new_user buckets) stays identical.
--
-- Migration also re-applies the grant + schema reload for completeness so
-- this file can be run standalone.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.feed_discover_v2(
  p_user_id uuid,
  p_limit   int default 20,
  p_offset  int default 0
) returns setof public.posts
language plpgsql stable security definer set search_path = public
as $$
declare
  v_drama_tag_ids uuid[];
begin
  if p_user_id is null then
    return;
  end if;

  -- Cache the drama/heartbreak/angst tag ids once for cheaper join
  select array_agg(id) into v_drama_tag_ids
  from public.tags
  where slug in ('drama', 'heartbreak', 'angst', 'dark-romance');

  return query
  with
    -- Followed creator ids — hard-excluded from Discover (they belong in
    -- the Following tab; surfacing them in Discover too dilutes the
    -- "discover NEW creators" signal).
    followed as (
      select following_id from public.follows where follower_id = p_user_id
    ),
    -- Eligible posts: not hidden, not by followed creators, recent.
    -- 2026-05-15: removed `and p.user_id <> p_user_id` so the viewer's
    -- own posts can also appear in Discover. The view-debounce CTE at
    -- the bottom still prevents repeat exposure once seen.
    candidates as (
      select p.*
      from public.posts p
      where p.is_hidden = false
        and p.user_id not in (select following_id from followed)
        and p.created_at > now() - interval '30 days'
    ),
    -- A: new romance creators (<30d signup, <100 followers)
    new_creator as (
      select c.id,
             0.25::float as score
      from candidates c
      join public.profiles pr on pr.id = c.user_id
      where pr.created_at > now() - interval '30 days'
        and (
          select count(*) from public.follows f where f.following_id = c.user_id
        ) < 100
    ),
    -- B: viral — engagement velocity in last 7d (likes per hour since post)
    virality as (
      select c.id,
             0.25::float * (
               (
                 (select count(*) from public.reactions r where r.target_id = c.id and r.target_type = 'post')
                 + 2 * (select count(*) from public.comments cm where cm.post_id = c.id)
               )::float
               / greatest(1, extract(epoch from (now() - c.created_at)) / 3600)
             ) as score
      from candidates c
      where c.created_at > now() - interval '7 days'
    ),
    -- C: drama / heartbreak / angst tag boost
    subgenre_drama as (
      select distinct c.id, 0.15::float as score
      from candidates c
      join public.post_tags pt on pt.post_id = c.id
      where pt.tag_id = any(coalesce(v_drama_tag_ids, array[]::uuid[]))
    ),
    -- D: trending videos — 24h view velocity
    trending_video as (
      select c.id,
             0.15::float * coalesce(c.views_count, 0)::float
               / greatest(1, extract(epoch from (now() - c.created_at)) / 3600)
             as score
      from candidates c
      where c.video_id is not null
        and c.created_at > now() - interval '24 hours'
    ),
    -- E: new writers (first post < 7d ago)
    new_writer as (
      select c.id, 0.10::float as score
      from candidates c
      where (
        select min(p2.created_at)
        from public.posts p2
        where p2.user_id = c.user_id
      ) > now() - interval '7 days'
    ),
    -- F: new users (signed up < 14d ago)
    new_user as (
      select c.id, 0.10::float as score
      from candidates c
      join public.profiles pr on pr.id = c.user_id
      where pr.created_at > now() - interval '14 days'
    ),
    combined as (
      select id, score from new_creator
      union all select id, score from virality
      union all select id, score from subgenre_drama
      union all select id, score from trending_video
      union all select id, score from new_writer
      union all select id, score from new_user
    ),
    ranked as (
      select id, sum(score) as total_score
      from combined
      group by id
      having sum(score) > 0
      order by total_score desc
      limit greatest(1, least(coalesce(p_limit, 20), 100)) + coalesce(p_offset, 0)
    )
  select p.*
  from public.posts p
  join ranked r on r.id = p.id
  where not exists (
    select 1 from public.post_views pv
    where pv.user_id = p_user_id
      and pv.post_id = p.id
      and pv.viewed_at > now() - interval '3 days'
  )
  order by r.total_score desc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
  offset coalesce(p_offset, 0);
end;
$$;

grant execute on function public.feed_discover_v2(uuid, int, int) to authenticated, anon;

-- Refresh PostgREST schema cache so the new body is picked up immediately.
notify pgrst, 'reload schema';
