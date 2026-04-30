-- ════════════════════════════════════════════════════════════════════════════
-- Selebox — Chat → Bell-Panel Notifications (task #201)
-- Run this in Supabase → SQL Editor → New query → paste → Run.
--
-- Purpose
-- -------
-- Insert a `dm_message` row into `notifications` whenever a chat `messages`
-- row is inserted, so the bell panel surfaces chat events with the same
-- coalescing pattern the web client already expects:
--   • One UNREAD bell row per (recipient_id, conversation_id).
--   • Subsequent messages bump that row in place (preview / actor / target /
--     created_at) so the inbox-style entry floats to the top.
--   • Once read, the next message creates a new unread row.
--
-- The web bell already renders type='dm_message' (see js/app.js — switch
-- case in `notificationLabel`, DM-aware nav in `onNotificationClick`, and the
-- realtime UPDATE handler whose comment reads "Coalesced DM notifications:
-- an existing unread row is being bumped"). This migration is the missing
-- write side that lights that path up.
--
-- Mobile reads need a parallel client-side change (Supabase fetch + realtime
-- merged with the existing Appwrite feed) — landed in selebox-mobile-main.
--
-- Prerequisites
-- -------------
--   • migration_notifications.sql (Phase 1) is already applied: defines the
--     `notifications` table, RLS policies, and realtime publication.
--   • Chat schema present with the columns referenced below — conversations
--     (user_a, user_b, is_group, archived_by_a/b, muted_until_a/b),
--     messages (conversation_id, sender_id, body, image_url, image_kind,
--     deleted_at), conversation_participants (conversation_id, user_id).
--
-- Safe to re-run — every DDL statement is idempotent.
-- ════════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- 0. REPLICA IDENTITY FULL on `notifications`.
-- ──────────────────────────────────────────────────────────────────────────
-- Required for Supabase Realtime UPDATE events to deliver full row payloads
-- (not just the PK). The web's existing realtime UPDATE handler reads
-- payload.new.id / actor_id / metadata / created_at — without REPLICA
-- IDENTITY FULL the bumped-row code path would silently break the moment
-- this trigger starts firing UPDATEs.
-- Idempotent.

alter table notifications replica identity full;


-- ──────────────────────────────────────────────────────────────────────────
-- 1. Partial unique index — enables atomic per-conversation coalescing.
-- ──────────────────────────────────────────────────────────────────────────
-- At most one UNREAD dm_message row per (recipient, conversation). The
-- trigger uses INSERT … ON CONFLICT DO UPDATE keyed on this index, which
-- atomically handles the race where two concurrent message INSERTs both try
-- to create the first bell entry for the same conversation.

create unique index if not exists notifications_dm_unread_unique
  on notifications (recipient_id, parent_target_id)
  where type = 'dm_message' and is_read = false;

-- Read-side index: fast lookup when a chat thread opens and we flip every
-- dm_message bell row for that conversation to read in one statement.
create index if not exists notifications_dm_lookup_idx
  on notifications (recipient_id, parent_target_id, created_at desc)
  where type = 'dm_message';


-- ──────────────────────────────────────────────────────────────────────────
-- 2. Helper — per-recipient upsert.
-- ──────────────────────────────────────────────────────────────────────────
-- Called from the trigger once per recipient. The ON CONFLICT clause matches
-- the partial unique index above; on collision we bump the unread row's
-- preview / actor / target / created_at so the row floats to top of the
-- bell with the most recent sender / message.

create or replace function _upsert_dm_notification(
  p_recipient   uuid,
  p_actor       uuid,
  p_message_id  uuid,
  p_conv_id     uuid,
  p_preview     text,
  p_is_group    boolean,
  p_now         timestamptz
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into notifications
    (recipient_id, actor_id, type,
     target_type, target_id,
     parent_target_type, parent_target_id,
     metadata, is_read, created_at)
  values
    (p_recipient, p_actor, 'dm_message',
     'message', p_message_id,
     'conversation', p_conv_id,
     jsonb_build_object('preview', p_preview, 'is_group', p_is_group),
     false, p_now)
  on conflict (recipient_id, parent_target_id)
    where type = 'dm_message' and is_read = false
  do update set
    actor_id   = excluded.actor_id,
    target_id  = excluded.target_id,
    -- Right-side wins on key conflict — preserves any future jsonb keys
    -- callers add to existing rows while overwriting preview / is_group.
    metadata   = notifications.metadata || excluded.metadata,
    created_at = excluded.created_at;
end;
$$;


-- ──────────────────────────────────────────────────────────────────────────
-- 3. Trigger function — message INSERT → fan out bell notifications.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function notify_on_chat_message() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_conv      conversations%rowtype;
  v_recipient uuid;
  v_preview   text;
  v_now       timestamptz := now();
begin
  -- Skip soft-deletes. AFTER INSERT normally has deleted_at NULL, but defend
  -- against future bulk loads / migrations replaying message history.
  if new.deleted_at is not null then
    return new;
  end if;

  select * into v_conv from conversations where id = new.conversation_id;
  if not found then
    return new;
  end if;

  -- Preview formatting matches the mobile chat-push.js convention so the
  -- bell preview, push notification, and conversation-list snippet all read
  -- the same way. We don't differentiate GIF vs photo here because
  -- chat-push.js doesn't, and `image_kind` isn't guaranteed to exist on the
  -- messages table (only the web select references it).
  if new.body is not null and length(btrim(new.body)) > 0 then
    v_preview := left(new.body, 120);
  elsif new.image_url is not null then
    v_preview := '📷 Photo';
  else
    v_preview := 'New message';
  end if;

  if v_conv.is_group then
    -- Group: fan out to every member except the sender. There is no
    -- per-member group mute / archive in the current schema, so all members
    -- receive a bell entry. (Adding member-level mute is future work and
    -- would slot in here cleanly.)
    for v_recipient in
      select cp.user_id
      from conversation_participants cp
      where cp.conversation_id = v_conv.id
        and cp.user_id <> new.sender_id
    loop
      perform _upsert_dm_notification(
        v_recipient, new.sender_id, new.id, v_conv.id,
        v_preview, true, v_now
      );
    end loop;
  else
    -- 1:1: notify the side that isn't the sender, respecting their archive
    -- and mute flags on the conversation row.
    if new.sender_id = v_conv.user_a then
      v_recipient := v_conv.user_b;
      if (v_conv.archived_by_b is not true)
         and (v_conv.muted_until_b is null or v_conv.muted_until_b < v_now) then
        perform _upsert_dm_notification(
          v_recipient, new.sender_id, new.id, v_conv.id,
          v_preview, false, v_now
        );
      end if;
    elsif new.sender_id = v_conv.user_b then
      v_recipient := v_conv.user_a;
      if (v_conv.archived_by_a is not true)
         and (v_conv.muted_until_a is null or v_conv.muted_until_a < v_now) then
        perform _upsert_dm_notification(
          v_recipient, new.sender_id, new.id, v_conv.id,
          v_preview, false, v_now
        );
      end if;
    end if;
    -- Sender not on either side of a 1:1 row → bad data; silently drop.
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_chat_message on messages;
create trigger trg_notify_chat_message after insert on messages
  for each row execute function notify_on_chat_message();


-- ──────────────────────────────────────────────────────────────────────────
-- 4. Client-facing RPCs — work for both auth modes.
-- ──────────────────────────────────────────────────────────────────────────
-- The mobile app currently runs with USE_SUPABASE_AUTH = false (Appwrite is
-- the auth source). Those clients have no Supabase session, so auth.uid()
-- is NULL and the existing RLS policies on `notifications` (recipient_id =
-- auth.uid()) deny every SELECT and UPDATE. The trigger above writes the
-- rows fine (SECURITY DEFINER bypasses RLS), but a mobile read or mark-
-- read would silently return zero rows.
--
-- The chat tables (`messages`, `conversations`) work for those users
-- because they have anon-permissive policies (see migration_chat_features
-- comments — "we use anon-permissive policies just like posts"). Loosening
-- `notifications` the same way would expose every user's notifications to
-- every anon client. Instead, we expose three SECURITY DEFINER RPCs that
-- accept an explicit user_id and trust it in the same security posture as
-- the rest of the chat write path. When mobile auth flips to Supabase,
-- callers can simply omit p_user_id (defaulted to NULL), and `coalesce`
-- falls through to `auth.uid()`.
--
-- Drop-then-create because mark_chat_notifications_read's signature
-- changed (added p_user_id default NULL).

drop function if exists mark_chat_notifications_read(uuid);

create or replace function mark_chat_notifications_read(
  p_conversation_id uuid,
  p_user_id         uuid default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if p_conversation_id is null then
    return;
  end if;

  update notifications
  set is_read = true
  where recipient_id = v_me
    and type = 'dm_message'
    and parent_target_type = 'conversation'
    and parent_target_id = p_conversation_id
    and is_read = false;
end;
$$;

grant execute on function mark_chat_notifications_read(uuid, uuid) to authenticated, anon;


-- Returns the most recent dm_message rows for the caller, paged by
-- p_before (timestamptz — pass null for the first page, then the
-- `created_at` of the last row from the previous page). Limit defaults to
-- 30 which fits the bell screen comfortably.
create or replace function get_chat_notifications(
  p_user_id uuid default null,
  p_limit   int  default 30,
  p_before  timestamptz default null
) returns setof notifications
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  return query
    select n.*
    from notifications n
    where n.recipient_id = v_me
      and n.type = 'dm_message'
      and (p_before is null or n.created_at < p_before)
    order by n.created_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 100));
end;
$$;

grant execute on function get_chat_notifications(uuid, int, timestamptz) to authenticated, anon;


-- Returns the unread dm_message count for the caller. Used by the mobile
-- bell badge for both initial and post-realtime recalc.
create or replace function get_chat_unread_count(
  p_user_id uuid default null
) returns int
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := coalesce(auth.uid(), p_user_id);
  v_count int;
begin
  if v_me is null then
    return 0;
  end if;

  select count(*) into v_count
  from notifications
  where recipient_id = v_me
    and type = 'dm_message'
    and is_read = false;

  return coalesce(v_count, 0);
end;
$$;

grant execute on function get_chat_unread_count(uuid) to authenticated, anon;


-- Bulk mark-read — clears every unread dm_message row for the caller.
-- Powers the bell screen's "Mark all read" + the bell-icon tap optimistic
-- clear in MainScreensHeader.
create or replace function mark_all_chat_notifications_read(
  p_user_id uuid default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  update notifications
  set is_read = true
  where recipient_id = v_me
    and type = 'dm_message'
    and is_read = false;
end;
$$;

grant execute on function mark_all_chat_notifications_read(uuid) to authenticated, anon;


-- ──────────────────────────────────────────────────────────────────────────
-- 5. Refresh PostgREST schema cache so the RPC is immediately callable.
-- ──────────────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (paste into the SQL editor after running)
-- ════════════════════════════════════════════════════════════════════════════
-- -- Trigger registered:
-- select tgname, tgrelid::regclass from pg_trigger
-- where tgname = 'trg_notify_chat_message';
--
-- -- Indexes present:
-- select indexname from pg_indexes where tablename = 'notifications'
-- and indexname in ('notifications_dm_unread_unique', 'notifications_dm_lookup_idx');
--
-- -- Send a test message (replace IDs with real ones), then:
-- select id, recipient_id, type, parent_target_id, metadata, created_at
-- from notifications where type = 'dm_message' order by created_at desc limit 5;


-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (uncomment all below to undo this migration)
-- ════════════════════════════════════════════════════════════════════════════
-- drop trigger if exists trg_notify_chat_message on messages;
-- drop function if exists notify_on_chat_message();
-- drop function if exists _upsert_dm_notification(uuid, uuid, uuid, uuid, text, boolean, timestamptz);
-- drop function if exists mark_chat_notifications_read(uuid, uuid);
-- drop function if exists mark_all_chat_notifications_read(uuid);
-- drop function if exists get_chat_notifications(uuid, int, timestamptz);
-- drop function if exists get_chat_unread_count(uuid);
-- drop index if exists notifications_dm_lookup_idx;
-- drop index if exists notifications_dm_unread_unique;
-- alter table notifications replica identity default;
-- notify pgrst, 'reload schema';
