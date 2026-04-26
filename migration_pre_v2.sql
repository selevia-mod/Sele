-- ════════════════════════════════════════════════════════════════════════════
-- Selebox — Pre-migration setup v2 (Tier 1 + Tier 2)
-- Run this BEFORE the expanded migration tool.
-- Idempotent — safe to re-run.
--
-- Adds:
--   • legacy_appwrite_id columns on the rest of the migration targets
--   • comments.book_id (so comments can target books, not just posts/videos)
--   • posts.views_count (so we can roll up posts-views)
--   • profiles.bio, profiles.banner_url (in case they're not there yet)
--   • Updated check constraint on comments to permit any of post/video/book
-- ════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1. profiles — make sure bio / banner_url exist
-- ──────────────────────────────────────────────────────────────────────────
alter table profiles add column if not exists bio        text;
alter table profiles add column if not exists banner_url text;
-- legacy_appwrite_id was added in migration_pre.sql

-- ──────────────────────────────────────────────────────────────────────────
-- 2. comments — book target + legacy id
-- ──────────────────────────────────────────────────────────────────────────
alter table comments add column if not exists book_id            uuid references books(id) on delete cascade;
alter table comments add column if not exists legacy_appwrite_id text;

-- Update the exclusivity check constraint to include book_id
alter table comments drop constraint if exists comments_target_check;
alter table comments add constraint comments_target_check check (
  (post_id  is not null and video_id is null     and book_id is null)
  or (post_id is null  and video_id is not null  and book_id is null)
  or (post_id is null  and video_id is null      and book_id is not null)
);

create index if not exists comments_book_id_idx
  on comments(book_id, created_at) where book_id is not null;
create unique index if not exists comments_legacy_appwrite_id_idx
  on comments(legacy_appwrite_id) where legacy_appwrite_id is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. chapter_comments — legacy id
-- ──────────────────────────────────────────────────────────────────────────
alter table chapter_comments add column if not exists legacy_appwrite_id text;
create unique index if not exists chapter_comments_legacy_appwrite_id_idx
  on chapter_comments(legacy_appwrite_id) where legacy_appwrite_id is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. posts — legacy id + views counter
-- ──────────────────────────────────────────────────────────────────────────
alter table posts add column if not exists legacy_appwrite_id text;
alter table posts add column if not exists views_count        integer not null default 0;
create unique index if not exists posts_legacy_appwrite_id_idx
  on posts(legacy_appwrite_id) where legacy_appwrite_id is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. follows — uses (follower_id, following_id) PK so no legacy id needed.
--    Just verify it has created_at for ordering.
-- ──────────────────────────────────────────────────────────────────────────
alter table follows add column if not exists created_at timestamptz not null default now();

-- ──────────────────────────────────────────────────────────────────────────
-- 6. reactions — already polymorphic. Just add legacy id for idempotency.
-- ──────────────────────────────────────────────────────────────────────────
alter table reactions add column if not exists legacy_appwrite_id text;
create unique index if not exists reactions_legacy_appwrite_id_idx
  on reactions(legacy_appwrite_id) where legacy_appwrite_id is not null;

notify pgrst, 'reload schema';
