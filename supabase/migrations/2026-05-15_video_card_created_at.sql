-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — fetch_video_card returns created_at
--
-- Charles 2026-05-15: "include in the 'video for you' the time stamp
-- details on the lower right of the thumbnail."
--
-- The RPC was already returning duration. We add created_at so mobile
-- can render a "Xd ago" / "Xh ago" relative timestamp alongside the
-- duration badge on the thumbnail corner. Useful signal — users can
-- tell at a glance whether the recommended video is fresh content or
-- an older trending piece.
--
-- Single-field addition to the JSONB payload. fetch_hybrid_feed
-- consumes the inner video object opaquely, so it doesn't need
-- changes. Mobile FeedVideoCard reads `data.created_at` and formats.
--
-- Idempotent — CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════════


begin;


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
  for v_row in (
    select
      v.id,
      v.title,
      v.thumbnail_url,
      v.video_url,
      v.duration,
      v.created_at,
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
      'created_at',             v_row.created_at,
      'uploader_id',            v_row.uploader_id,
      'uploader_username',      v_row.uploader_username,
      'uploader_display_name',  v_row.uploader_display_name,
      'uploader_avatar_url',    v_row.uploader_avatar_url,
      'views_count',            v_row.views_count,
      'likes_count',            v_row.likes_count,
      'comments_count',         v_row.comments_count
    );
  end loop;

  if v_video is null then
    for v_row in (
      select
        v.id,
        v.title,
        v.thumbnail_url,
        v.video_url,
        v.duration,
        v.created_at,
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
        'created_at',             v_row.created_at,
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

revoke all on function public.fetch_video_card(int, uuid[], uuid[]) from public;
grant execute on function public.fetch_video_card(int, uuid[], uuid[]) to authenticated, anon;


notify pgrst, 'reload schema';


commit;


-- VERIFICATION:
-- select public.fetch_video_card(0, '{}'::uuid[], '{}'::uuid[]) -> 'video' ->> 'created_at';
-- Expect: ISO 8601 timestamp, not null.
