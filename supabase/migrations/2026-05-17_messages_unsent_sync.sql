-- ════════════════════════════════════════════════════════════════════════
-- HOTFIX: unsent messages not syncing to mobile on conversation re-open
-- ════════════════════════════════════════════════════════════════════════
-- User report (2026-05-17): "When a message is unsent on the website, it
-- still appears when the conversation is opened in the mobile app."
--
-- Triage (both code paths verified correct in this repo):
--   • Web deleteMessage: UPDATE messages SET deleted_at = now, body = ''
--     WHERE id = ? AND sender_id = me   (js/messages.js ~L1444)
--   • Mobile loadMessages: SELECT includes deleted_at (lib/messages-supabase.js ~L880)
--   • Mobile bubble: branches on deleted_at and renders "Message deleted"
--     (components/SupabaseThread.jsx L156, L268)
--
-- The remaining failure modes this migration shores up:
--   1. The messages table isn't in the supabase_realtime publication
--      → mobile never receives the UPDATE event and only sees stale data
--        until a full reload.
--   2. REPLICA IDENTITY default → UPDATE payloads only carry the changed
--        columns; mobile's onMessageUpdate may not see deleted_at.
--   3. RLS for SELECT must allow conversation participants to see updates
--        (including the soft-deleted state).
--
-- This migration is idempotent: if everything is already configured
-- correctly, all statements no-op. Safe to run multiple times.
--
-- Schema notes for this DB (confirmed via web client code):
--   • 1:1 conversations carry participants directly: user_a, user_b
--     columns on the `conversations` row.
--   • Group conversations track members in `conversation_participants`
--     (user_id, role, last_read_at, conversation_id).
--
-- The SELECT policy below honors BOTH patterns so groups + 1:1 work.
-- ────────────────────────────────────────────────────────────────────────

-- 1. Ensure messages is included in the realtime publication. Without this
--    the postgres_changes UPDATE subscription in mobile's
--    subscribeToConversation() never receives the unsent event.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
end $$;

-- 2. REPLICA IDENTITY FULL so UPDATE payloads carry both new + old row
--    data. Mobile's onMessageUpdate uses payload.new — without FULL,
--    columns the UPDATE statement didn't touch arrive as null and the
--    deleted_at flag can be missed during the local merge.
alter table public.messages replica identity full;

-- 3. SELECT policy: conversation participants (1:1 via user_a/user_b
--    on conversations, OR group members via conversation_participants)
--    see every message in their conversation, including soft-deleted
--    rows so the "Message deleted" placeholder can render on all
--    clients. Idempotent via DROP IF EXISTS + CREATE.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'messages'
       and policyname = 'messages_select_participants'
  ) then
    drop policy messages_select_participants on public.messages;
  end if;

  create policy messages_select_participants
    on public.messages
    for select
    using (
      exists (
        select 1
          from public.conversations c
         where c.id = messages.conversation_id
           and (c.user_a = auth.uid() or c.user_b = auth.uid())
      )
      or
      exists (
        select 1
          from public.conversation_participants cp
         where cp.conversation_id = messages.conversation_id
           and cp.user_id = auth.uid()
      )
    );
end $$;

-- 4. UPDATE policy — only the sender can modify their own message. The
--    web client already gates on sender_id = auth.uid() but enforcing
--    it server-side prevents future clients from skipping the check.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'messages'
       and policyname = 'messages_update_own'
  ) then
    drop policy messages_update_own on public.messages;
  end if;

  create policy messages_update_own
    on public.messages
    for update
    using (sender_id = auth.uid())
    with check (sender_id = auth.uid());
end $$;

-- Verification block — run after applying to confirm the realtime
-- subscription works end-to-end:
--
--   -- On the web, in the console while in a conversation with another
--   -- user, run a manual unsend:
--   --   await supabase.from('messages').update({ deleted_at: new Date().toISOString(), body: '' }).eq('id', '<msg-id>')
--   --
--   -- Then on mobile (the recipient device), the bubble for <msg-id>
--   -- should flip to "Message deleted" within ~1 second — no app reload
--   -- required. If it doesn't, capture the mobile build version (some
--   -- older OTAs may not have the SupabaseThread onMessageUpdate handler
--   -- — those users need an EAS update).
