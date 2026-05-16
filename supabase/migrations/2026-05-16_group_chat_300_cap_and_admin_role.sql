-- ════════════════════════════════════════════════════════════════════════
-- Group chat: 300-member cap + admin role
-- ════════════════════════════════════════════════════════════════════════
--
-- Adds two intertwined features to group conversations:
--
--   (1) HARD CAP of 300 members per group. Enforced via BEFORE INSERT
--       trigger on conversation_participants, so it catches the
--       create_group_conversation RPC, the addGroupMembers client
--       insert (mobile + web), and any future write path uniformly.
--
--   (2) ADMIN ROLE concept. conversation_participants.role gets a CHECK
--       constraint accepting only 'creator', 'admin', 'member'. The
--       creator (conversations.created_by) is auto-stamped on insert
--       via trigger. Creator may promote/demote any non-creator member
--       to 'admin' via the new set_group_member_role() RPC. Both
--       creator and admin may add members (enforced via RLS); kick +
--       leave behavior unchanged for now.
--
-- Why a trigger for the cap (and not a CHECK constraint)?
--   CHECK constraints can't reference other rows. We need COUNT(*)
--   against the same table — a BEFORE INSERT trigger is the standard
--   pattern for this kind of cross-row invariant.
--
-- Why a trigger for auto-stamping the creator role?
--   create_group_conversation already exists as an RPC but its source
--   isn't in this repo (predates the supabase/migrations/ folder).
--   Rather than CREATE OR REPLACE blind, we attach a BEFORE INSERT
--   trigger that sets role='creator' whenever the inserted participant
--   IS the conversation's created_by. Idempotent + version-safe.
--
-- Backfill: existing groups get their creator row promoted in step 2.
-- Existing non-creator rows stay 'member' (no admins exist yet).
--
-- Rollback: drop the three new triggers, the RPC, the policy, the
-- CHECK constraint. Backfilled creator roles can be reverted by
-- `UPDATE conversation_participants SET role='member' WHERE role='creator'`
-- but no caller distinguishes them currently so leaving them is safe.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Role CHECK constraint
-- ─────────────────────────────────────────────────────────────────────
-- Drop any prior role check (defensive — schemas in the wild may have
-- been created without one).
ALTER TABLE conversation_participants
  DROP CONSTRAINT IF EXISTS conversation_participants_role_check;

ALTER TABLE conversation_participants
  ADD CONSTRAINT conversation_participants_role_check
  CHECK (role IN ('creator', 'admin', 'member'));

-- ─────────────────────────────────────────────────────────────────────
-- 2. Backfill 'creator' role on existing group memberships
-- ─────────────────────────────────────────────────────────────────────
-- For each group conversation, mark its created_by participant row as
-- 'creator'. 1:1 DMs unaffected — they don't have a meaningful creator
-- distinction (both parties are equal).
UPDATE conversation_participants p
SET role = 'creator'
FROM conversations c
WHERE p.conversation_id = c.id
  AND c.is_group = true
  AND p.user_id = c.created_by
  AND p.role IS DISTINCT FROM 'creator';

-- ─────────────────────────────────────────────────────────────────────
-- 3. Auto-stamp 'creator' role on INSERT for the group's created_by
-- ─────────────────────────────────────────────────────────────────────
-- NOTE 2026-05-16 (Codex review P2-273): the original comment claimed
-- this trigger "fires before the cap trigger". That's wrong. Postgres
-- fires BEFORE triggers in alphabetical name order ascending, so
-- `trg_enforce_group_member_cap` (step 4) actually runs FIRST, then
-- `trg_participant_auto_creator_role`. The cap check doesn't depend
-- on role so practical impact is zero, but the comment was lying.
-- Corrected for any future code that genuinely depends on ordering.
--
-- Idempotent for non-group inserts (returns NEW unchanged).
CREATE OR REPLACE FUNCTION _participant_auto_creator_role()
RETURNS TRIGGER AS $$
DECLARE
  v_created_by UUID;
  v_is_group   BOOLEAN;
BEGIN
  SELECT created_by, is_group
    INTO v_created_by, v_is_group
    FROM conversations
   WHERE id = NEW.conversation_id;
  IF v_is_group IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id = v_created_by THEN
    NEW.role := 'creator';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_participant_auto_creator_role
  ON conversation_participants;
CREATE TRIGGER trg_participant_auto_creator_role
  BEFORE INSERT ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION _participant_auto_creator_role();

-- ─────────────────────────────────────────────────────────────────────
-- 4. 300-member cap (BEFORE INSERT trigger)
-- ─────────────────────────────────────────────────────────────────────
-- Counts current participants of the same group and rejects the insert
-- if the count is already at 300. The trigger fires per row, so a
-- bulk insert that crosses the boundary fails cleanly at the offending
-- row (the prior rows in the same statement land).
CREATE OR REPLACE FUNCTION _enforce_group_member_cap()
RETURNS TRIGGER AS $$
DECLARE
  v_is_group BOOLEAN;
  v_count    INT;
BEGIN
  SELECT is_group INTO v_is_group
    FROM conversations WHERE id = NEW.conversation_id;
  IF v_is_group IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM conversation_participants
   WHERE conversation_id = NEW.conversation_id;

  IF v_count >= 300 THEN
    RAISE EXCEPTION 'group_full'
      USING HINT    = 'Groups are capped at 300 members.',
            ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_group_member_cap
  ON conversation_participants;
CREATE TRIGGER trg_enforce_group_member_cap
  BEFORE INSERT ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION _enforce_group_member_cap();

-- ─────────────────────────────────────────────────────────────────────
-- 5. RLS: only creator OR admin may INSERT participants into a group
-- ─────────────────────────────────────────────────────────────────────
-- 1:1 DMs unchanged (insert path is the get_or_create_conversation RPC
-- which runs SECURITY DEFINER and bypasses RLS). For groups, three
-- legitimate insert cases:
--   (a) During group creation: the create_group_conversation RPC runs
--       SECURITY DEFINER too and bypasses RLS, so this policy doesn't
--       block legitimate group creation.
--   (b) After group exists: caller is creator or admin → allow.
--   (c) The creator inserting themselves into a brand-new group with
--       no participants yet → allow (last-resort path for clients that
--       call .insert() directly instead of the RPC).
--
-- NOTE 2026-05-16 (Codex review P1-7 / task #267): branch (c) is
-- effectively dead code in practice. create_group_conversation is
-- SECURITY DEFINER and already inserts the creator's participant row
-- before this policy gets to evaluate, so the "no participants yet"
-- precondition is unreachable from any real client path. Kept for now
-- as defense-in-depth; safe to remove in a follow-up cleanup.
--
-- NOTE 2026-05-16 (Codex review P0-1 / task #259): the ORIGINAL
-- `WHERE p.conversation_id = conversation_id` in branch (a) here was
-- buggy — unqualified `conversation_id` resolved to `p.conversation_id`
-- inside the subquery, making the predicate trivially true. Any group
-- creator/admin could insert into ANY group. Fixed by hotfix migration
-- 2026-05-16_group_admins_rls_qualify_hotfix.sql which fully qualifies
-- every column reference and renames the inner alias `p` → `existing`
-- so future shadowing is visually obvious. Keep this comment for
-- future readers debugging the policy timeline.
--
-- Note: the cap trigger from step 4 fires AFTER this policy passes,
-- so a creator trying to push #301 still gets the friendly cap error.
DROP POLICY IF EXISTS group_admins_can_add_members
  ON conversation_participants;
CREATE POLICY group_admins_can_add_members
  ON conversation_participants
  FOR INSERT
  WITH CHECK (
    -- (a)+(b): caller already a creator/admin of THIS conversation
    EXISTS (
      SELECT 1 FROM conversation_participants p
       WHERE p.conversation_id = conversation_id
         AND p.user_id = auth.uid()
         AND p.role IN ('creator', 'admin')
    )
    OR
    -- (c): brand-new group, no participants yet, caller is created_by
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = conversation_id
         AND c.is_group = true
         AND c.created_by = auth.uid()
         AND NOT EXISTS (
           SELECT 1 FROM conversation_participants existing
            WHERE existing.conversation_id = c.id
         )
    )
    OR
    -- Allow 1:1 DM inserts (is_group=false) — the existing pair-init
    -- flow inserts both rows at once and is gated by other RLS already.
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = conversation_id
         AND c.is_group = false
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- 6. Role-change trigger — only creator may change role; can't demote
--    the creator
-- ─────────────────────────────────────────────────────────────────────
-- Implemented as a trigger (not RLS) because RLS's WITH CHECK can't
-- reference OLD/NEW comparisons — we need to permit non-role updates
-- (archive flags, muted_until, etc.) but block role changes from
-- non-creators.
CREATE OR REPLACE FUNCTION _guard_role_changes()
RETURNS TRIGGER AS $$
BEGIN
  -- Fast path: role didn't change, allow.
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;
  -- Role IS changing — caller must be the conversation's creator.
  IF NOT EXISTS (
    SELECT 1 FROM conversations c
     WHERE c.id = NEW.conversation_id
       AND c.created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'only_creator_can_change_roles'
      USING ERRCODE = 'P0001';
  END IF;
  -- Creator cannot be demoted (would orphan the group).
  IF OLD.role = 'creator' THEN
    RAISE EXCEPTION 'cannot_demote_creator'
      USING ERRCODE = 'P0001';
  END IF;
  -- Creator cannot be re-assigned by promoting someone else to it.
  IF NEW.role = 'creator' THEN
    RAISE EXCEPTION 'cannot_assign_creator'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_role_changes
  ON conversation_participants;
CREATE TRIGGER trg_guard_role_changes
  BEFORE UPDATE ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION _guard_role_changes();

-- ─────────────────────────────────────────────────────────────────────
-- 7. RPC: set_group_member_role — friendly wrapper for clients
-- ─────────────────────────────────────────────────────────────────────
-- Returns a JSONB result with { ok, role?, error? } so clients can
-- show actionable toasts ("Only the creator can change roles", etc.)
-- without parsing Postgres error codes.
CREATE OR REPLACE FUNCTION set_group_member_role(
  p_conv_id UUID,
  p_user_id UUID,
  p_role    TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller       UUID := auth.uid();
  v_created_by   UUID;
  v_is_group     BOOLEAN;
  v_current_role TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF p_role NOT IN ('admin', 'member') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_role');
  END IF;

  SELECT created_by, is_group
    INTO v_created_by, v_is_group
    FROM conversations WHERE id = p_conv_id;
  IF v_created_by IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation_not_found');
  END IF;
  IF v_is_group IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_group');
  END IF;
  IF v_created_by != v_caller THEN
    RETURN jsonb_build_object('ok', false, 'error', 'only_creator');
  END IF;

  SELECT role INTO v_current_role
    FROM conversation_participants
   WHERE conversation_id = p_conv_id AND user_id = p_user_id;
  IF v_current_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_not_in_group');
  END IF;
  IF v_current_role = 'creator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot_demote_creator');
  END IF;

  UPDATE conversation_participants
     SET role = p_role
   WHERE conversation_id = p_conv_id AND user_id = p_user_id;

  RETURN jsonb_build_object('ok', true, 'role', p_role);
END;
$$;

GRANT EXECUTE ON FUNCTION set_group_member_role(UUID, UUID, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- Done. After this migration:
--   • All existing group creators have role='creator'
--   • Future group inserts auto-stamp creator role
--   • Inserts beyond 300 members get group_full error
--   • Non-creator/non-admin RLS-blocked from adding members
--   • Only creator can promote/demote, via set_group_member_role RPC
-- ════════════════════════════════════════════════════════════════════════
