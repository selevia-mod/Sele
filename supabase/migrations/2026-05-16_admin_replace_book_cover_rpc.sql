-- ════════════════════════════════════════════════════════════════════════
-- Server-side gate for admin book-cover replacement
-- ════════════════════════════════════════════════════════════════════════
--
-- Closes task #231. The homepage Trending/Recent shelves render an
-- admin-only pencil overlay (js/app.js _replaceBookCoverFromHome at
-- ~line 4264) that lets admins fix bad covers without leaving the page.
-- The visibility gate is CLIENT-SIDE — currentProfile.role check at
-- ~line 4377. A signed-in non-admin user could inject the DOM via
-- DevTools and trigger the underlying .update() call.
--
-- For most cases the existing books-table RLS would catch them
-- (regular author-only UPDATE policy prevents non-authors from
-- modifying anyone else's books). The vulnerability shape is more
-- subtle:
--   (a) If books RLS allows the author of book X to update their own
--       row, a malicious non-admin could only ever replace covers on
--       books they already own — a no-op from a damage standpoint.
--   (b) BUT if any RLS rule allows broader UPDATE (e.g. a "soft delete"
--       or "moderation flag" policy with a permissive WITH CHECK), the
--       client-side admin check is the only gate stopping abuse.
--   (c) Either way, having admin moderation actions ALSO routed through
--       a SECURITY DEFINER RPC with explicit role check matches the
--       earnings + KYC patterns in the rest of the codebase and gives
--       us a single chokepoint for auditing.
--
-- This migration adds:
--   1. admin_replace_book_cover(p_book_id, p_cover_url) RPC — verifies
--      caller is admin OR moderator, updates books.cover_url +
--      updated_at, returns the new URL on success.
--   2. Returns JSONB { ok, cover_url? | error? } so client can show
--      friendly toasts without parsing Postgres error codes.
--
-- Author's own cover updates continue through the existing direct
-- .update() path (books-table RLS handles author-ownership). The new
-- RPC is the ONLY entry point for cross-author cover replacement.
--
-- Rollback: drop the function. Client code path will fall back to
-- the direct .update() which RLS may or may not allow depending on
-- the calling user's authorship — admins lose the homepage shortcut
-- but no data is at risk.

-- ─────────────────────────────────────────────────────────────────────
-- 1. admin_replace_book_cover RPC
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_replace_book_cover(
  p_book_id   UUID,
  p_cover_url TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller    UUID := auth.uid();
  v_role      TEXT;
  v_book_id   UUID;
BEGIN
  -- Auth gate. Anonymous callers (no JWT) get a clear signal.
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  -- Validate inputs before doing anything else.
  IF p_book_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_book_id');
  END IF;
  IF p_cover_url IS NULL OR length(trim(p_cover_url)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_cover_url');
  END IF;
  -- URL sanity check — reject anything that doesn't look like an http(s)
  -- URL. Doesn't prevent storage abuse but blocks accidental garbage
  -- like a local path or a base64 blob landing in the column.
  IF p_cover_url !~ '^https?://' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_cover_url');
  END IF;

  -- Role gate — admin OR moderator only. Matches the same role check
  -- used by the existing admin RPCs (admin_verify_earning,
  -- admin_resolve_kyc, etc.).
  SELECT role INTO v_role FROM profiles WHERE id = v_caller;
  IF v_role NOT IN ('admin', 'moderator') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- Book must exist (otherwise UPDATE silently affects zero rows and
  -- the client thinks it succeeded). Lock the row briefly so two
  -- concurrent admin updates serialize cleanly.
  SELECT id INTO v_book_id FROM books WHERE id = p_book_id FOR UPDATE;
  IF v_book_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'book_not_found');
  END IF;

  -- Perform the swap. updated_at follows the same convention as the
  -- old direct path so any sort-by-updated views (Recently Updated
  -- carousel etc.) don't break.
  UPDATE books
     SET cover_url  = p_cover_url,
         updated_at = NOW()
   WHERE id = p_book_id;

  RETURN jsonb_build_object('ok', true, 'cover_url', p_cover_url);
END;
$$;

-- The function runs as the table owner (SECURITY DEFINER) so RLS on
-- books doesn't restrict it. The role check above is the ONLY gate.
GRANT EXECUTE ON FUNCTION admin_replace_book_cover(UUID, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- Done. After this migration:
--   • Homepage admin pencil → switch to RPC call (next commit on JS side)
--   • Non-admin attempting the RPC → "forbidden" toast, no DB change
--   • Anonymous attempting the RPC → "not_authenticated" toast
--   • Garbage URL → "invalid_cover_url" toast
--   • Stale book id (deleted mid-action) → "book_not_found" toast
-- ════════════════════════════════════════════════════════════════════════
