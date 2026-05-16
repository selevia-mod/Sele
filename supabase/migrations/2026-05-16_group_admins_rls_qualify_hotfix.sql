-- ════════════════════════════════════════════════════════════════════════
-- Hotfix: qualify ambiguous conversation_id in group_admins_can_add_members
-- ════════════════════════════════════════════════════════════════════════
--
-- The 2026-05-16_group_chat_300_cap_and_admin_role.sql migration's RLS
-- policy at lines 159-164 referenced `conversation_id` unqualified
-- inside a subquery that also aliased `conversation_participants` as
-- `p`. Postgres resolved the inner reference to `p.conversation_id`,
-- making the predicate `p.conversation_id = p.conversation_id` —
-- always true.
--
-- Effect of the bug: any authenticated user who is a creator or admin
-- of ANY group conversation could insert participants into ANY OTHER
-- group conversation, full stop. The cap trigger still fires (so they
-- couldn't push a group past 300 members) and the UNIQUE constraint
-- on (conversation_id, user_id) still prevented duplicate rows, but
-- this is real cross-tenant lateral movement.
--
-- Discovered by Codex review on 2026-05-16. Confirmed by our own
-- independent review pass (P0-1 in MESSAGES_DOCK_CODEX_REVIEW.md).
--
-- This hotfix:
--   1. Drops the buggy policy.
--   2. Recreates it with EVERY column reference fully qualified —
--      no unqualified `conversation_id` references anywhere in the
--      expression tree, even in branches that happened to be safe
--      under the prior version (branches (b) and (c) referenced
--      `c.id = conversation_id` where `c` is `conversations` which
--      has no `conversation_id` column, so they resolved to the
--      outer row — but relying on the absence of a column name
--      collision is fragile, so we qualify those too).
--   3. Uses `conversation_participants.conversation_id` to reference
--      the row being inserted. Postgres RLS expressions inside
--      WITH CHECK can address the inserted row via the policy
--      target table name.
--
-- Rollback: re-apply the previous policy from
-- 2026-05-16_group_chat_300_cap_and_admin_role.sql (reintroduces the
-- security hole — do not roll back unless absolutely necessary).

-- ─────────────────────────────────────────────────────────────────────
-- 1. Drop the buggy policy
-- ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS group_admins_can_add_members
  ON conversation_participants;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Recreate with fully-qualified column references
-- ─────────────────────────────────────────────────────────────────────
-- Same three permitted insert paths as the original — just safely
-- qualified. Renamed inner alias `p` → `existing` so the human eye
-- catches any future regression (an alias that doesn't match a table
-- name in the outer scope can't accidentally shadow it).
CREATE POLICY group_admins_can_add_members
  ON conversation_participants
  FOR INSERT
  WITH CHECK (
    -- (a) Caller is already creator/admin of THIS conversation.
    --     Inner alias `existing` avoids the name collision that
    --     broke the original; outer reference is explicit on the
    --     policy target table.
    EXISTS (
      SELECT 1
        FROM conversation_participants existing
       WHERE existing.conversation_id = conversation_participants.conversation_id
         AND existing.user_id         = auth.uid()
         AND existing.role            IN ('creator', 'admin')
    )
    OR
    -- (b) Brand-new group with no participants yet, caller is
    --     created_by. Largely dead path in practice (create_group_
    --     conversation RPC is SECURITY DEFINER and bypasses RLS),
    --     kept as defense-in-depth for any future client that
    --     inserts the creator row directly via .insert(). Tracked
    --     as task #267 for follow-up cleanup.
    EXISTS (
      SELECT 1
        FROM conversations c
       WHERE c.id         = conversation_participants.conversation_id
         AND c.is_group   = true
         AND c.created_by = auth.uid()
         AND NOT EXISTS (
           SELECT 1
             FROM conversation_participants seed
            WHERE seed.conversation_id = c.id
         )
    )
    OR
    -- (c) 1:1 DM insert (is_group=false). The pair-init flow inserts
    --     both rows at once and is gated by other RLS already; this
    --     branch keeps that path working.
    EXISTS (
      SELECT 1
        FROM conversations c
       WHERE c.id       = conversation_participants.conversation_id
         AND c.is_group = false
    )
  );

-- ════════════════════════════════════════════════════════════════════════
-- Verification queries (run manually after deploy if you want proof):
--
-- 1. Confirm the policy exists and shows the new expression:
--      SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr,
--             pg_get_expr(polwithcheck, polrelid) AS check_expr
--        FROM pg_policy
--       WHERE polrelid = 'conversation_participants'::regclass;
--    The check_expr should contain `conversation_participants.conversation_id`
--    three times (one per branch), NOT bare `conversation_id`.
--
-- 2. Negative test (run as a non-admin/non-member of group X):
--      INSERT INTO conversation_participants
--             (conversation_id, user_id, role)
--      VALUES ('<group X id>', auth.uid(), 'member');
--    Should fail with: new row violates row-level security policy.
--
-- 3. Positive test (run as creator of group X):
--      INSERT INTO conversation_participants
--             (conversation_id, user_id, role)
--      VALUES ('<group X id>', '<some user id>', 'member');
--    Should succeed (subject to 300-member cap).
-- ════════════════════════════════════════════════════════════════════════
