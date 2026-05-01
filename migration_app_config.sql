-- ════════════════════════════════════════════════════════════════════════════
-- Selebox — App config / global settings table
--
-- Replaces the Appwrite `globalSettings` collection that mobile reads via
-- lib/appwrite.js → getGlobalSettings(). Once mobile cuts over to Supabase
-- auth (Task #40), the Appwrite path will 401 — we need this table populated
-- BEFORE that flag flips.
--
-- All values are stored as TEXT and parsed client-side based on `value_type`.
-- This avoids the headache of mixed-type columns and lets us evolve the
-- schema (add value_type='duration', value_type='url', etc.) without DDL.
--
-- The admin UI in admin.html → Settings tab is the maintenance interface.
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- 1. Table
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  key          text primary key,
  value        text,
  value_type   text not null default 'string'
                 check (value_type in ('string', 'number', 'boolean', 'array', 'json')),
  category     text not null default 'general',
  description  text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles(id)
);

create index if not exists app_config_category_idx on public.app_config(category);


-- ──────────────────────────────────────────────────────────────────────────
-- 2. RLS — public read, admin-only write
-- ──────────────────────────────────────────────────────────────────────────
-- Mobile + web read these on every session bootstrap. Writes are admin-only,
-- enforced by checking the caller's role on the profiles table. Editor /
-- moderator roles cannot change settings — admin only.

alter table public.app_config enable row level security;

drop policy if exists "app_config public read" on public.app_config;
create policy "app_config public read" on public.app_config
  for select using (true);

drop policy if exists "app_config admin write" on public.app_config;
create policy "app_config admin write" on public.app_config
  for all
  using (
    exists (
      select 1 from public.profiles
       where id = auth.uid() and role = 'admin' and not is_banned
    )
  );


-- ──────────────────────────────────────────────────────────────────────────
-- 3. updated_at + updated_by triggers
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.app_config_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists app_config_touch on public.app_config;
create trigger app_config_touch
  before update on public.app_config
  for each row execute function public.app_config_touch();


-- ──────────────────────────────────────────────────────────────────────────
-- 4. Seed — all 46 keys mobile reads today
-- ──────────────────────────────────────────────────────────────────────────
-- Values default to sensible production approximations. Update from the
-- Appwrite globalSettings collection via the admin Settings tab BEFORE
-- flipping USE_SUPABASE_AUTH = true. Use upsert (on conflict do nothing) so
-- re-running the migration doesn't clobber admin edits.

insert into public.app_config (key, value, value_type, category, description) values
  -- ── Books ─────────────────────────────────────────────────────────────
  ('BOOKS_CATEGORIES',                  '["Romance","Fantasy","Mystery","Sci-Fi","Drama"]', 'array',   'books',   'Available book genre filters in the Books tab'),
  ('BOOKS_CHAPTER_COIN_PRICE',          '5',                                                  'number',  'books',   'Default coins to unlock one chapter'),
  ('BOOKS_CHAPTER_STAR_PRICE',          '1',                                                  'number',  'books',   'Default stars to unlock one chapter'),
  ('BOOKS_CHAPTER_LOCK_START',          '4',                                                  'number',  'books',   'Global fallback: chapter # at which paywall starts (per-book lock_from_chapter overrides this)'),
  ('BOOKS_CHAPTER_MIN_CHAR_SIZE',       '500',                                                'number',  'books',   'Minimum characters required when authoring a chapter'),
  ('BOOKS_CHAPTER_MAX_CHAR_SIZE',       '50000',                                              'number',  'books',   'Maximum characters allowed in a single chapter'),
  ('BOOKS_CHAPTER_IMAGE_MAX_SIZE_MB',   '5',                                                  'number',  'books',   'Max upload size for inline chapter images (MB)'),
  ('BOOKS_COVER_MAX_SIZE_MB',           '5',                                                  'number',  'books',   'Max upload size for book cover image (MB)'),
  ('BOOKS_INTRODUCTION_MIN_WORD_COUNT', '50',                                                 'number',  'books',   'Minimum word count for the book introduction'),
  ('BOOKS_INTRODUCTION_MAX_WORD_COUNT', '500',                                                'number',  'books',   'Maximum word count for the book introduction'),
  ('BOOKS_SYNOPSIS_MIN_WORD_COUNT',     '20',                                                 'number',  'books',   'Minimum synopsis word count'),
  ('BOOKS_SYNOPSIS_MAX_WORD_COUNT',     '300',                                                'number',  'books',   'Maximum synopsis word count'),
  ('BOOKS_TITLE_MAX_CHAR_SIZE',         '100',                                                'number',  'books',   'Max characters in a book title'),
  ('BOOKS_TAGS_MAX_SIZE',               '10',                                                 'number',  'books',   'Max number of tags per book'),
  ('BOOKS_UNLOCK_WHOLE_DISCOUNT',       '0.2',                                                'number',  'books',   'Discount fraction (0.2 = 20%) when unlocking the whole book at once'),

  -- ── Videos ────────────────────────────────────────────────────────────
  ('VIDEO_UPLOAD_SIZE_MB',              '100',                                                'number',  'videos',  'Max video upload size (MB)'),
  ('FEED_AUTO_PAUSE_VIDEO_TIMER',       '15',                                                 'number',  'videos',  'Seconds before auto-pausing a video in the feed'),
  ('LIMIT_VIDEOS_PER_CATEGORY',         '20',                                                 'number',  'videos',  'Max videos shown per category in the Videos tab'),

  -- ── Posts ─────────────────────────────────────────────────────────────
  ('POST_LIMIT_SIZE_CHARS',             '2000',                                               'number',  'posts',   'Max characters in a post body'),
  ('POST_UPLOAD_SIZE_MB',               '10',                                                 'number',  'posts',   'Max image upload size per post (MB)'),
  ('POST_UPLOAD_MAX',                   '4',                                                  'number',  'posts',   'Max images per post'),
  ('POSTS_SUGGESTED_CLIPS_COUNT',       '3',                                                  'number',  'posts',   'How many clips to suggest after each post'),
  ('POSTS_SUGGESTED_CREATORS_COUNT',    '5',                                                  'number',  'posts',   'How many creator suggestions to render in feed'),
  ('POSTS_SUGGESTED_VIDEOS_COUNT',      '3',                                                  'number',  'posts',   'How many videos to suggest after each post'),
  ('TITLE_LIMIT_SIZE_CHARS',            '100',                                                'number',  'posts',   'Generic title char limit (used by post composer)'),

  -- ── Clips (deprecated — being removed) ────────────────────────────────
  ('CLIPS_DURATION_MIN',                '3',                                                  'number',  'clips',   'Minimum clip duration in seconds'),
  ('CLIPS_DURATION_MAX',                '60',                                                 'number',  'clips',   'Maximum clip duration in seconds'),
  ('CLIPS_BEFORE_AD_LIMIT',             '5',                                                  'number',  'clips',   'Show interstitial ad after watching N clips'),

  -- ── Stories ───────────────────────────────────────────────────────────
  ('STORY_IMAGE_DURATION',              '5',                                                  'number',  'stories', 'Seconds an image story stays on screen'),

  -- ── Comments ──────────────────────────────────────────────────────────
  ('COMMENT_SECTION_QUERY_LIMIT',       '20',                                                 'number',  'comments','How many comments load per page'),

  -- ── Ads ───────────────────────────────────────────────────────────────
  ('ANDROID_INTERSTITIAL_PROD_ID',      'ca-app-pub-0000000000000000/0000000000',             'string',  'ads',     'AdMob production interstitial ad unit ID (Android)'),
  ('ANDROID_NATIVE_AD_PROD_ID',         'ca-app-pub-0000000000000000/0000000000',             'string',  'ads',     'AdMob production native ad unit ID (Android)'),
  ('IOS_INTERSTITIAL_PROD_ID',          'ca-app-pub-0000000000000000/0000000000',             'string',  'ads',     'AdMob production interstitial ad unit ID (iOS)'),
  ('IOS_NATIVE_AD_PROD_ID',             'ca-app-pub-0000000000000000/0000000000',             'string',  'ads',     'AdMob production native ad unit ID (iOS)'),
  ('DEFAULT_ADS_INTERVAL_MIN',          '3',                                                  'number',  'ads',     'Min minutes between interstitial ad shows'),
  ('WATCH_AD_COOLDOWN_TIMER',           '60',                                                 'number',  'ads',     'Seconds users must wait between rewarded ad watches'),
  ('EXCLUDE_ADS_ON_GENRE',              '[]',                                                 'array',   'ads',     'Genres where no ads should be shown (e.g., Religion)'),

  -- ── Engagement multipliers ────────────────────────────────────────────
  ('LIKES_MULTIPLIER',                  '1',                                                  'number',  'engagement', 'Display multiplier for like counts (vanity inflation; 1 = no inflation)'),
  ('VIEWS_MULTIPLIER',                  '1',                                                  'number',  'engagement', 'Display multiplier for view counts'),

  -- ── Earnings / Withdrawals ────────────────────────────────────────────
  ('PLATFORM_COST',                     '0.3',                                                'number',  'earnings','Platform fee fraction taken from author earnings (0.3 = 30%)'),
  ('TRANSFER_FEE',                      '0.05',                                               'number',  'earnings','Transfer fee fraction on withdrawals (0.05 = 5%)'),
  ('WITHDRAWAL_MINIMUM_AMOUNT',         '10',                                                 'number',  'earnings','Minimum withdrawal amount in USD'),

  -- ── Permissions ───────────────────────────────────────────────────────
  ('ADMIN_EMAILS',                      '[]',                                                 'array',   'permissions','Email addresses with admin privileges (legacy — admin role on profiles is canonical)'),
  ('BCC_EMAILS',                        '[]',                                                 'array',   'permissions','Email addresses BCCed on system emails'),

  -- ── Misc ──────────────────────────────────────────────────────────────
  ('TAGS_LIMIT_MAX',                    '15',                                                 'number',  'misc',    'Hard cap on tags across the app'),
  ('THUMBNAIL_UPLOAD_SIZE_MB',          '5',                                                  'number',  'misc',    'Max thumbnail upload size (MB)'),
  ('SORTED_CATEGORIES',                 '["Romance","Fantasy","Mystery","Sci-Fi","Drama"]',   'array',   'misc',    'Display order for category filters across surfaces')
on conflict (key) do nothing;


-- ──────────────────────────────────────────────────────────────────────────
-- 5. Refresh PostgREST cache
-- ──────────────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════════
-- -- Row count should be 46
-- select count(*) from public.app_config;
--
-- -- Categories breakdown
-- select category, count(*) from public.app_config group by category order by category;
--
-- -- Spot-check a key
-- select key, value, value_type, category from public.app_config where key = 'BOOKS_CHAPTER_LOCK_START';
--
-- -- Verify RLS works (run as anon — should succeed)
-- select key, value from public.app_config limit 5;
