-- ════════════════════════════════════════════════════════════════════════════
-- Selebox — Post Actions: Hide, Snooze, Block, Report
--
-- Adds 4 tables that power the post kebab menu:
--   • post_hides    — per-user "I don't want to see this post" list
--   • user_snoozes  — temporarily mute another user's content (with expiry)
--   • user_blocks   — permanently block another user (bidirectional in feeds)
--   • post_reports  — reports that admins/mods will review on the admin page
--
-- All FKs to profiles(id) use ON UPDATE CASCADE so they survive the lazy-auth
-- claim flow (profile.id rewrite when a legacy user signs in for the first time).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1. post_hides — per-user "hide this post from my feed"
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.post_hides (
  user_id     uuid not null references public.profiles(id) on update cascade on delete cascade,
  post_id     uuid not null references public.posts(id)    on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index if not exists post_hides_user_idx on public.post_hides(user_id, created_at desc);

alter table public.post_hides enable row level security;

drop policy if exists "users manage own hides" on public.post_hides;
create policy "users manage own hides"
  on public.post_hides
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 2. user_snoozes — temporarily mute a user (auto-expires)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.user_snoozes (
  user_id         uuid not null references public.profiles(id) on update cascade on delete cascade,
  target_user_id  uuid not null references public.profiles(id) on update cascade on delete cascade,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, target_user_id),
  check (user_id <> target_user_id)
);

create index if not exists user_snoozes_user_idx     on public.user_snoozes(user_id, expires_at);
-- Plain index — don't use a WHERE expires_at > now() predicate because
-- now() is STABLE, not IMMUTABLE, and Postgres rejects non-immutable functions in predicates.
create index if not exists user_snoozes_expires_idx  on public.user_snoozes(expires_at);

alter table public.user_snoozes enable row level security;

drop policy if exists "users manage own snoozes" on public.user_snoozes;
create policy "users manage own snoozes"
  on public.user_snoozes
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 3. user_blocks — permanent block (bidirectional in feed enforcement)
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.user_blocks (
  user_id          uuid not null references public.profiles(id) on update cascade on delete cascade,
  blocked_user_id  uuid not null references public.profiles(id) on update cascade on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (user_id, blocked_user_id),
  check (user_id <> blocked_user_id)
);

create index if not exists user_blocks_user_idx     on public.user_blocks(user_id);
create index if not exists user_blocks_blocked_idx  on public.user_blocks(blocked_user_id);

alter table public.user_blocks enable row level security;

drop policy if exists "users manage own blocks" on public.user_blocks;
create policy "users manage own blocks"
  on public.user_blocks
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- When you block someone, also unfollow them (both directions).
create or replace function public.handle_block_unfollow()
returns trigger
language plpgsql
security definer
as $$
begin
  delete from public.follows
   where (follower_id = NEW.user_id          and following_id = NEW.blocked_user_id)
      or (follower_id = NEW.blocked_user_id  and following_id = NEW.user_id);
  return NEW;
end $$;

drop trigger if exists on_block_unfollow on public.user_blocks;
create trigger on_block_unfollow
  after insert on public.user_blocks
  for each row
  execute function public.handle_block_unfollow();

-- ──────────────────────────────────────────────────────────────────────────
-- 4. post_reports — submitted by users, reviewed by admins/mods
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists public.post_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid references public.profiles(id) on update cascade on delete set null,
  post_id      uuid not null references public.posts(id) on delete cascade,
  reason       text not null check (reason in ('spam','harassment','hate','nsfw','self_harm','other')),
  details      text,
  status       text not null default 'pending' check (status in ('pending','reviewing','resolved','dismissed')),
  reviewed_by  uuid references public.profiles(id) on update cascade on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists post_reports_status_idx on public.post_reports(status, created_at);
create index if not exists post_reports_post_idx   on public.post_reports(post_id);

-- Optional: prevent the same user from spamming the same post with reports
create unique index if not exists post_reports_unique_per_reporter
  on public.post_reports(reporter_id, post_id)
  where reporter_id is not null;

alter table public.post_reports enable row level security;

-- Anyone signed-in can submit a report (their own reporter_id only)
drop policy if exists "anyone can submit reports" on public.post_reports;
create policy "anyone can submit reports"
  on public.post_reports
  for insert
  with check (auth.uid() = reporter_id);

-- Reporters can see the reports THEY filed (status updates etc.)
drop policy if exists "reporters see own reports" on public.post_reports;
create policy "reporters see own reports"
  on public.post_reports
  for select
  using (auth.uid() = reporter_id);

-- Admin/mod read + update policies will be added when we build the admin role.

notify pgrst, 'reload schema';
