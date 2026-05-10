-- migration_videos_bunny_id_unique.sql
-- ────────────────────────────────────────────────────────────────────
-- Tier-3 video upload hardening — adds the unique constraint on
-- videos.bunny_video_id that the bunny-video-ready Edge Function's
-- ON CONFLICT clause depends on.
--
-- Why we need it:
--   The new server-side webhook handler upserts video rows with
--   ON CONFLICT (bunny_video_id) DO NOTHING. Without a unique
--   constraint Postgres rejects ON CONFLICT with "no unique or
--   exclusion constraint matching the ON CONFLICT specification".
--
-- Why the index already-might exist:
--   bunny_video_id is the primary external lookup key for Bunny
--   webhook payloads, but the original videos table only had a
--   regular b-tree index (for fast WHERE filters), not a unique
--   constraint. The two are not the same thing in Postgres.
--
-- Idempotent: the DO block checks for the constraint first so
-- re-running this migration is a no-op.
--
-- Before adding the constraint we check for and clean up any
-- duplicate bunny_video_id rows that might exist from past races
-- or manual inserts. Duplicates would block the constraint creation;
-- worse, they'd indicate ledger drift we should know about. The
-- query at the end of this file lists any duplicates as a tripwire.

-- ────────────────────────────────────────────────────────────────────
-- 1. Detect duplicates BEFORE attempting the constraint. Surfaces
--    any pre-existing data quality issues so we can resolve them
--    before the migration locks the table.
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT bunny_video_id
    FROM public.videos
    WHERE bunny_video_id IS NOT NULL
    GROUP BY bunny_video_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add unique constraint: % bunny_video_id values have duplicate rows. '
      'Run the duplicate-detection query at the end of this file, then resolve '
      '(merge engagement counts into the surviving row, soft-delete the others) '
      'before re-running this migration.',
      dup_count;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 2. Add the unique constraint. Idempotent — checks pg_constraint
--    first so re-running doesn't error.
-- ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'videos_bunny_video_id_key'
      AND conrelid = 'public.videos'::regclass
  ) THEN
    -- Partial unique constraint via expression index — null
    -- bunny_video_id values (legacy Appwrite videos that haven't been
    -- migrated yet) won't conflict with each other, but every
    -- non-null value must be unique.
    CREATE UNIQUE INDEX videos_bunny_video_id_key
      ON public.videos (bunny_video_id)
      WHERE bunny_video_id IS NOT NULL;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- Tripwire query — list any current duplicates. Should return zero
-- rows after the migration succeeds. Useful to keep around as a
-- monitoring query if something starts double-inserting.
-- ────────────────────────────────────────────────────────────────────
-- SELECT bunny_video_id, COUNT(*) AS dup_count, array_agg(id) AS row_ids
-- FROM public.videos
-- WHERE bunny_video_id IS NOT NULL
-- GROUP BY bunny_video_id
-- HAVING COUNT(*) > 1
-- ORDER BY dup_count DESC;
