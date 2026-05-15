-- ════════════════════════════════════════════════════════════════════════════
-- Allow target_type='video' in the reactions CHECK constraint.
-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-15. The web Like button on the video player surfaces
-- `reactions_target_type_check` violations because the original
-- constraint didn't include 'video' as a valid value (only post, comment,
-- book, chapter, story). Mobile has long emitted target_type='video' too,
-- so this constraint must have been silently swallowing those writes from
-- mobile as well — or mobile uses a separate code path that bypasses it.
-- Either way, the fix is to accept 'video'.
--
-- We DROP IF EXISTS first because the constraint name varies in older
-- environments. Then re-add with the full whitelist.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.reactions
  drop constraint if exists reactions_target_type_check;

alter table public.reactions
  add constraint reactions_target_type_check
  check (target_type in ('post', 'comment', 'book', 'chapter', 'video', 'story'));

-- Refresh PostgREST so the new constraint shape is reflected on the next request.
notify pgrst, 'reload schema';
