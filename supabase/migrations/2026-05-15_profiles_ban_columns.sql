-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Add banned_at / banned_reason / banned_by to profiles
--
-- Background
-- ----------
-- profiles.is_banned (boolean) already exists from a long-ago migration
-- and the moderation triggers / RLS policies reference it. But the
-- companion columns I assumed existed don't:
--   • banned_at      — when the ban was applied
--   • banned_reason  — visible in audit log + admin UI
--   • banned_by      — actor who applied the ban
--
-- The admin_ban_user / admin_unban_user / admin_kyc_list RPCs
-- (2026-05-15_admin_kyc_security_rpcs.sql + column-name fix) reference
-- all three. They compiled fine because PG defers column-reference
-- validation, but raised at runtime as soon as the admin opened
-- Payouts → KYC review:
--   ERROR: column p.banned_reason does not exist
--
-- This adds the missing columns idempotently. Safe to re-run; safe
-- to deploy on a database that already has them.
-- ════════════════════════════════════════════════════════════════════════

begin;

alter table public.profiles
  add column if not exists banned_at      timestamptz,
  add column if not exists banned_reason  text,
  add column if not exists banned_by      uuid references public.profiles(id);

commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
-- Confirm all four ban-related columns exist:
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'profiles'
--      and column_name in ('is_banned', 'banned_at', 'banned_reason', 'banned_by')
--    order by column_name;
--
-- Expect 4 rows.


-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- alter table public.profiles
--   drop column if exists banned_at,
--   drop column if exists banned_reason,
--   drop column if exists banned_by;
--
-- Note: dropping these columns will break admin_ban_user, admin_unban_user,
-- and admin_kyc_list. Only roll back if you're also rolling back the KYC
-- security RPC migrations.
