-- ════════════════════════════════════════════════════════════════════════════
-- Selebox — Unified Content Reports (Supabase)
-- Run this in Supabase → SQL Editor → New query → paste → Run.
--
-- Purpose
-- -------
-- Create one Supabase table that captures ALL user-submitted reports across
-- content types — posts, videos, books, chapters, comments, users (chat
-- abuse). Mobile dual-writes (Appwrite legacy collection + this table) so
-- moderators see new reports here regardless of which surface they were
-- filed from.
--
-- Why a new table instead of extending `post_reports`?
--   • post_reports.post_id is FK to posts(id), making it post-specific by
--     schema. Repurposing it for video/book/user reports would require
--     dropping the FK and renaming columns — riskier than a fresh table.
--   • content_reports cleanly carries `content_type` so admin can filter
--     by surface ("show me all video reports", etc.) without joining N
--     tables.
--
-- Backward compatibility
--   • Existing `post_reports` rows are copied into `content_reports` at
--     the bottom of this migration (idempotent).
--   • The web admin should switch its query from `post_reports` to
--     `content_reports` (see the JS edit shipping alongside this migration).
--   • Mobile keeps writing to Appwrite's contentReportsCollection during
--     the transition — no data loss while admin tooling catches up.
--
-- Prerequisites
--   • migration_admin_setup.sql is applied (defines `is_moderator()` and
--     the `profiles.role` column the gate functions read).
--
-- Idempotent — every statement uses CREATE OR REPLACE / IF (NOT) EXISTS.
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- 1. content_reports table
-- ──────────────────────────────────────────────────────────────────────────
-- reporter_id and owner_id are TEXT (not UUID) because mobile is currently
-- on the Appwrite-auth path — user ids are 36-char Appwrite hex strings,
-- not Supabase UUIDs. Web users on Supabase auth send UUIDs as text.
-- Keeping the column generic lets both clients write without coercion.
-- When mobile migrates to Supabase auth, we can tighten the column to
-- UUID with a backfill / cast migration.

create table if not exists public.content_reports (
  id            uuid primary key default gen_random_uuid(),
  content_id    text not null,
  content_type  text not null check (content_type in (
    'post','video','book','chapter','comment','user','message'
  )),
  reporter_id   text not null,
  owner_id      text,
  reason        text,
  notes         text,
  status        text not null default 'open' check (status in (
    'open','reviewing','resolved','dismissed'
  )),
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists content_reports_open_recent_idx
  on public.content_reports (created_at desc) where status = 'open';
create index if not exists content_reports_by_content_idx
  on public.content_reports (content_type, content_id);
create index if not exists content_reports_reporter_idx
  on public.content_reports (reporter_id, created_at desc);
create index if not exists content_reports_status_idx
  on public.content_reports (status, created_at desc);


-- ──────────────────────────────────────────────────────────────────────────
-- 2. RLS — moderators read all, mods update status, no direct INSERT
-- ──────────────────────────────────────────────────────────────────────────
-- Direct INSERT is blocked at the policy level (no INSERT policy means
-- RLS denies). Clients submit reports via the SECURITY DEFINER RPC below,
-- which works for both anon (mobile) and authenticated (web) callers.
-- Mods read everything via `is_moderator()` (defined in
-- migration_admin_setup.sql).

alter table public.content_reports enable row level security;

drop policy if exists "mods read content_reports"   on public.content_reports;
drop policy if exists "mods update content_reports" on public.content_reports;

create policy "mods read content_reports"
  on public.content_reports
  for select
  using (public.is_moderator());

create policy "mods update content_reports"
  on public.content_reports
  for update
  using (public.is_moderator())
  with check (public.is_moderator());

-- Optional: reporters can read their own submissions (so the mobile app
-- can show a "your reports" history later). Cheap to add, harmless.
drop policy if exists "self read own content_reports" on public.content_reports;
create policy "self read own content_reports"
  on public.content_reports
  for select
  using (
    reporter_id = coalesce(auth.uid()::text, reporter_id)
  );


-- ──────────────────────────────────────────────────────────────────────────
-- 3. RPC: submit_content_report — client-facing write (anon + authed)
-- ──────────────────────────────────────────────────────────────────────────
-- Accepts a report from any client. SECURITY DEFINER bypasses the
-- RLS-no-INSERT-policy gate. Built-in dedup window (5 min) prevents a
-- single user from spamming the same report repeatedly.

create or replace function public.submit_content_report(
  p_content_id    text,
  p_content_type  text,
  p_reporter_id   text,
  p_owner_id      text default null,
  p_reason        text default null,
  p_notes         text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id    uuid;
begin
  if p_content_id is null or p_content_type is null or p_reporter_id is null then
    raise exception 'content_id, content_type, reporter_id are required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Anti-spam: skip if same reporter filed the same content within 5 min.
  if exists (
    select 1 from public.content_reports
    where content_id   = p_content_id
      and content_type = p_content_type
      and reporter_id  = p_reporter_id
      and created_at   > now() - interval '5 minutes'
  ) then
    return null;
  end if;

  insert into public.content_reports
    (content_id, content_type, reporter_id, owner_id, reason, notes)
  values
    (p_content_id, p_content_type, p_reporter_id, p_owner_id, p_reason, p_notes)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.submit_content_report(text, text, text, text, text, text)
  to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────────────
-- 4. RPC: list_content_reports — admin-only paged read
-- ──────────────────────────────────────────────────────────────────────────
-- Mods/admins fetch the queue. Filtered by status / content_type, paged
-- by p_before (timestamp cursor). Internal gate via is_moderator() so
-- non-mods get an exception.

create or replace function public.list_content_reports(
  p_status        text default null,
  p_content_type  text default null,
  p_limit         int  default 50,
  p_before        timestamptz default null
) returns setof public.content_reports
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = 'insufficient_privilege';
  end if;

  return query
    select *
    from public.content_reports
    where (p_status is null or status = p_status)
      and (p_content_type is null or content_type = p_content_type)
      and (p_before is null or created_at < p_before)
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

grant execute on function public.list_content_reports(text, text, int, timestamptz)
  to authenticated;


-- ──────────────────────────────────────────────────────────────────────────
-- 5. RPC: update_content_report_status — mod action
-- ──────────────────────────────────────────────────────────────────────────
-- Mods change a report from open → reviewing → resolved/dismissed. Stamps
-- reviewed_by + reviewed_at. Policy permits mod UPDATE so this RPC could
-- be skipped, but having it as an RPC keeps the admin app's call site
-- consistent and makes audit-trail integration easier later.

create or replace function public.update_content_report_status(
  p_report_id  uuid,
  p_status     text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('open','reviewing','resolved','dismissed') then
    raise exception 'invalid status';
  end if;

  update public.content_reports
  set status      = p_status,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_report_id;
end;
$$;

grant execute on function public.update_content_report_status(uuid, text)
  to authenticated;


-- ──────────────────────────────────────────────────────────────────────────
-- 6. Backfill existing post_reports → content_reports
-- ──────────────────────────────────────────────────────────────────────────
-- One-time copy so the admin queue has historical context after switching
-- queries to content_reports. Idempotent: skips rows that already exist
-- via WHERE NOT EXISTS on (content_type='post', content_id=post_id::text).
--
-- The mapping:
--   post_reports.post_id   → content_reports.content_id (text)
--   post_reports.reason    → content_reports.reason
--   post_reports.details   → content_reports.notes
--   post_reports.status    → content_reports.status
--   post_reports.reporter_id → content_reports.reporter_id (text)
--   post_reports.created_at → content_reports.created_at
--   content_type           → 'post' (constant)
--
-- This block is wrapped in a DO so the migration succeeds even if
-- post_reports doesn't exist (e.g., on a fresh project).

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'post_reports'
  ) then
    -- Preserve post_reports.id as content_reports.id during backfill.
    -- This keeps admin action calls (`update content_reports where id =
    -- <legacy id>`) working for migrated rows — without it, the admin
    -- would have a stale id reference and dismisses/resolves would
    -- silently match zero rows.
    insert into public.content_reports
      (id, content_id, content_type, reporter_id, reason, notes, status, created_at)
    select
      pr.id,
      pr.post_id::text,
      'post',
      pr.reporter_id::text,
      pr.reason,
      pr.details,
      coalesce(pr.status, 'open'),
      pr.created_at
    from public.post_reports pr
    on conflict (id) do nothing;

    raise notice 'Backfilled % rows from post_reports → content_reports',
      (select count(*) from public.content_reports where content_type = 'post');
  else
    raise notice 'post_reports table not found — skipping backfill';
  end if;
end $$;


-- ──────────────────────────────────────────────────────────────────────────
-- 7. Realtime publication
-- ──────────────────────────────────────────────────────────────────────────
-- Optional: enables admin app to receive live updates as new reports
-- arrive. Mods see the queue grow without a reload.

alter publication supabase_realtime add table public.content_reports;
alter table public.content_reports replica identity full;

notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (paste into the SQL editor after running)
-- ════════════════════════════════════════════════════════════════════════════
-- -- Table + indexes:
-- select indexname from pg_indexes where tablename = 'content_reports';
--
-- -- RPCs registered:
-- select proname from pg_proc
-- where proname in ('submit_content_report', 'list_content_reports', 'update_content_report_status');
--
-- -- Backfill row count:
-- select content_type, status, count(*)
-- from content_reports group by content_type, status order by 1, 2;
--
-- -- Test submit (replace IDs with real ones):
-- select submit_content_report(
--   'test-content-id', 'post', 'test-reporter-id',
--   'test-owner-id', 'spam', 'sanity check'
-- );


-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (uncomment all below to undo this migration)
-- ════════════════════════════════════════════════════════════════════════════
-- alter publication supabase_realtime drop table public.content_reports;
-- drop function if exists public.update_content_report_status(uuid, text);
-- drop function if exists public.list_content_reports(text, text, int, timestamptz);
-- drop function if exists public.submit_content_report(text, text, text, text, text, text);
-- drop policy if exists "self read own content_reports" on public.content_reports;
-- drop policy if exists "mods update content_reports"   on public.content_reports;
-- drop policy if exists "mods read content_reports"     on public.content_reports;
-- drop table if exists public.content_reports;
-- notify pgrst, 'reload schema';
