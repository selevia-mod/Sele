-- ════════════════════════════════════════════════════════════════════════════
-- Selebox — Lazy auth migration setup (Plan A)
--
-- Goal:
--   • Profiles can exist BEFORE a Supabase auth.users row.
--   • On first sign-in, the new auth user "claims" the legacy profile by
--     matching email — keeping all books/posts/videos/comments linked.
--
-- Run this BEFORE Phase 1 of the migration tool.
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1. profiles.email — add column + case-insensitive unique index
-- ──────────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists email text;

-- Backfill from auth.users for any existing real users
update public.profiles p
set    email = u.email
from   auth.users u
where  p.id = u.id
  and  p.email is null
  and  u.email is not null;

-- Lowercased unique index — case-insensitive matching for "claim by email"
create unique index if not exists profiles_email_lower_idx
  on public.profiles (lower(email)) where email is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Drop FK from profiles.id → auth.users(id)
--    (so we can insert legacy profiles without a matching auth.users row)
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  fk_name text;
begin
  for fk_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.profiles'::regclass
      and con.contype  = 'f'
      and con.confrelid = 'auth.users'::regclass
  loop
    execute format('alter table public.profiles drop constraint %I', fk_name);
    raise notice 'Dropped FK %', fk_name;
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Rebuild all FKs that reference profiles.id with ON UPDATE CASCADE
--    (so when we rewrite a claimed profile's id, all owned content follows)
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  rec record;
  new_def text;
begin
  for rec in
    select
      n.nspname  as schema_name,
      c.relname  as table_name,
      con.conname as constraint_name,
      pg_get_constraintdef(con.oid) as constraint_def
    from pg_constraint con
    join pg_class     c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype  = 'f'
      and con.confrelid = 'public.profiles'::regclass
      and pg_get_constraintdef(con.oid) !~* 'on update cascade'
  loop
    raise notice 'Rebuilding FK % on %.%', rec.constraint_name, rec.schema_name, rec.table_name;
    execute format('alter table %I.%I drop constraint %I',
                   rec.schema_name, rec.table_name, rec.constraint_name);

    new_def := rec.constraint_def;
    if new_def ~* 'on update' then
      new_def := regexp_replace(new_def, 'on update [a-z ]+', 'ON UPDATE CASCADE', 'i');
    else
      new_def := new_def || ' ON UPDATE CASCADE';
    end if;

    execute format('alter table %I.%I add constraint %I %s',
                   rec.schema_name, rec.table_name, rec.constraint_name, new_def);
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Replace handle_new_user trigger:
--    On auth.users INSERT, try to claim a legacy profile by email match.
--    If no legacy match, fall through to creating a fresh profile.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  claimed_id uuid;
begin
  if NEW.email is not null then
    -- Try to claim a legacy profile by email (one that came from Appwrite)
    update public.profiles
    set    id         = NEW.id,
           updated_at = now()
    where  lower(email)         = lower(NEW.email)
      and  legacy_appwrite_id   is not null
      and  id <> NEW.id
    returning id into claimed_id;

    if claimed_id is not null then
      -- Successful claim — owned content (books, posts, videos, etc.) cascades
      return NEW;
    end if;
  end if;

  -- No legacy match — create a fresh profile (standard new-signup path)
  insert into public.profiles (id, username, email, avatar_url, created_at)
  values (
    NEW.id,
    coalesce(NEW.raw_user_meta_data->>'username',
             split_part(coalesce(NEW.email, ''), '@', 1)),
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url',
    now()
  )
  on conflict (id) do nothing;

  return NEW;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

notify pgrst, 'reload schema';
