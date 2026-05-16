# Stage 9 — Codex Review Brief (Messages page, 9A + 9B combined)

## Context

Closing the original 9-stage extraction roadmap. Stage 9 moves the
full-page Messenger UI out of `js/app.js` into `js/messages.js`. We
split into 9A (core) + 9B (extras) for blast-radius reasons, but
Charles wanted them reviewed together since they share state and the
intra-9A-↔-9B bridges that 9A temporarily exposed all collapse once
9B lands. This brief covers both.

The floating Messages dock at `js/messages-dock.js` was Phase 1 of
the Messages decomposition (separate effort earlier in the
session) — it factored out the shared data layer
(`loadConversationList`, `sendMessageToConversation`, etc.) that
both the dock UI and the full page now call into. Stage 9 is the
page-UI extraction on top of that data layer.

## Files in the diff

- `js/messages.js` (NEW, 3,657 lines) — skeleton header + 36 fns
  from 9A + 46 fns from 9B + 14 state vars/consts + accessor pairs
  for mutable state + SECRET_LOCK export
- `js/app.js` (16,811 → 13,509 lines, **−3,302**) — 82 fns + 14
  state vars removed; import block expanded; `initMessages({...})`
  added; DM-page event listener block (lines ~13270+) rewritten to
  use accessor pairs for the 3 mutable state vars
- `scripts/extract-stage9a.js` (NEW) — codemod for 9A (36 fns + 6
  state vars)
- `scripts/extract-stage9b.js` (NEW) — codemod for 9B (46 fns + 8
  state vars)
- `scripts/scan-messages9a-undef.js` (NEW) — pre-flight scanner;
  only false-positives (destructured `data`, `fetchErr`, `msgErr`)
  remained after the planned bridges were registered
- `js/app.js.before-stage9a` + `js/app.js.before-stage9b` +
  `js/messages.js.before-stage9b` — backups for diffing

## What moved — Stage 9A (Messages core)

**Functions (36):** showMessages, openConversation,
openConversationWithUser, loadConversationList,
renderConversationList, renderConvEmptyStateHtml, renderConvItemHtml,
fetchUnreadCounts, isConvMutedForMe, renderGroupAvatarHtml,
senderUsernameInGroup, loadMessages, renderMessages,
formatMessageDateStamp, formatStampLabel, sendDmMessage,
sendDmThumbsUp, updateSendButton, resizeDmInput,
scrollMessagesToBottom, isDmAtBottom, fetchReactionsForConversation,
toggleReaction, deleteMessage, startEditMessage, saveEditMessage,
openHoverMenu, closeHoverMenu, openReactionPicker,
closeReactionPicker, copyMessageText, subscribeToThread,
subscribeToPresenceAndTyping, updateThreadPresenceUI,
broadcastTyping, subscribeToInbox, computeDmUnreadTotal,
updateUnreadBadge, bootstrapDmBadge.

**State (6):** dmState (~30 fields — conversations, activeConvId,
messages, reactions, channels, typing/presence, hover/reaction
pickers, editingMessageId, replyingTo, viewMode), _dmSendInFlight,
_renderedMessageIds, DM_EMPTY_HTML, DM_QUICK_REACTIONS,
__convInboxCache.

## What moved — Stage 9B (Messages extras)

**Functions (46):**
- Mention dropdown (6): getMentionDropdown, closeMentionDropdown,
  positionMentionDropdown, maybeShowMentionDropdown,
  renderMentionDropdown, selectMention
- Secret-lock helpers (2): wireSecretTabHandlers,
  renderSecretLockGateHtml
- Reply state (3): startReplyToMessage, showReplyPreview,
  hideReplyPreview
- Conv menu (9): closeConvMenu, openConvActionsMenu, toggleConvMute,
  archiveConversation, confirmDeleteConversation, confirmLeaveGroup,
  showGroupMembersDialog, promptRenameGroup, handleGroupAvatarPicked
- Group admin (3): openAddMembersModal, kickGroupMember,
  refreshActiveConvMembers
- Secret conv helpers + new conv (4): dmIsMutualFollow,
  dmGetOrCreateSecretConv, openSecretChatPicker, openNewConvModal
- Global search renderers (2): renderGlobalSearchResults,
  highlightSearchMatch
- Attach menu (7): closeDmAttachMenu, fileToDataUrl,
  compressImageToJpeg, showDmAttachPreview, hideDmAttachPreview,
  formatBytes, sendDmAttachment
- GIF picker (4): closeDmGifPicker, openDmGifPicker, loadGifResults,
  sendDmGif
- Emoji picker (3): closeDmEmojiPicker, openScopedEmojiPicker
  (exported), insertEmojiIntoComposer
- DM link preview (4): parseSeleboxInternalUrl,
  renderInternalPreviewCard, renderDmLinkPreview,
  hydrateDmInternalPreviews

**State (8):** SECRET_LOCK (IIFE-as-const),
_dmInternalPreviewCache, _dmSearchTimer, _dmPendingAttachment,
_dmAttachMenuEl, _dmGifPickerEl, _dmEmojiPickerEl,
_dmEmojiPickerTrigger.

## `_cfg` bridge surface — final state

The `initMessages({...})` call in app.js is unusually narrow for a
module this size. The vast majority of DM logic is self-contained:
internal helpers call siblings directly, dmState is the canonical
shared object, the dock module provides the shared data layer
through its own exports.

What remained after 9B's bridge-collapse pass:
- **Identity**: getCurrentUser, getCurrentProfile
- **Navigation**: hideAllMainPages, openProfile, setSidebarActive,
  stopVideoPlayer
- **Shared dialogs**: confirmDialog, closeAllModals, uploadImage
- **Formatters**: formatCompact, linkify
- **firstUrlInText** — the only 9B-era bridge that survived. It's
  shared with the general feed `renderLinkPreview` that stays in
  app.js. Moving it would force a cycle (messages.js needs it for
  `renderDmLinkPreview`; app.js needs it for the general feed). One
  bridge entry was the cheaper trade.

22 9B-era bridges that 9A temporarily had (emoji picker, attach
menu, GIF picker, secret lock IIFE, reply state, conv menu, group
admin, mention dropdown, DM link preview) all dropped at 9B-time
because the functions moved into messages.js alongside their
callers.

## Live-binding exports + accessor pairs

This is the unusual part of Stage 9 and the most likely place
Codex will want to verify behavior.

**Live `let`/`const` exports** (read AND write across modules):
- `dmState` — 54 read/write call sites in remaining app.js code
  (still-in-app.js stuff that touches dmState). Exported as a
  `let` so the import binding stays live; mutations through field
  access (`dmState.activeConvId = X`) propagate because both sides
  hold the same object reference.
- `_renderedMessageIds` — a `const Set`, similar story. The set
  is shared; calls like `_renderedMessageIds.add(id)` from app.js
  reach the same Set instance in messages.js.

**Accessor pairs** (read-only ES module bindings don't allow
reassignment, so a regular `let` export would error on the write
side):
- `getDmAttachMenuEl` / `setDmAttachMenuEl`
- `getDmPendingAttachment` / `setDmPendingAttachment`
- `getDmSearchTimer` / `setDmSearchTimer`

These wrap three mutable locals that app.js's DM-page event-
listener block (lines ~13270+) needs to reassign. The wiring block
itself should migrate into a `wireMessagesPage()` initializer
inside messages.js (matching the Stage 8 `wireBooksPage` /
`wireBookReader` pattern) — that's queued as a follow-up; once it
lands, all three accessors can be retired and the state stays
fully encapsulated.

**Read-only export** (no setter needed):
- `SECRET_LOCK` — the IIFE-built lock controller. App.js still calls
  `SECRET_LOCK.isUnlocked()` + `.onVisibilityChange()` from boot
  wiring at line ~13127. Member access on imported `const` bindings
  works through ES modules.

## Export-wrapper handling

Three functions were defined as `export async function …` /
`export function …` in app.js (leftover from earlier cross-module
exports). The codemod's `findFunction` path detects an
ExportNamedDeclaration wrapping a matching FunctionDeclaration and
removes the WHOLE wrapper, not just the inner function — otherwise
we'd be left with an empty `export ;` and a parse error.

- `showMessages` (used by notification routing in app.js)
- `openConversation` (used by various conv-open paths)
- `openScopedEmojiPicker` (used by the floating dock for the
  shared scoped emoji picker)

All three are now exported via the `export { ... }` block at the
bottom of messages.js.

## What's intentionally NOT moved

- **messages-dock.js** — already its own module (Phase 1 of the
  Messages decomposition). Both the dock UI and the full-page
  call into its shared data helpers
  (`loadConversationList`, `fetchConversationById`,
  `loadMessagesForConversation`, `sendMessageToConversation`,
  `markConversationRead`, `subscribeToConversation`,
  `teardownConversationSubscription`).
- **notifications.js** — its own module since Stage 1.
- **Topbar search routing** — app.js owns search context
  (videos/books/feed/profile/messages) routing; messages.js's
  internal `dmSearchInput` global-search handler is wired
  separately at line ~13286 of app.js (in the wiring block that
  still needs migration).
- **firstUrlInText** — stays in app.js (general feed link
  preview also uses it).
- **renderLinkPreview** (general) and **youtubeIdFromUrl** — app.js
  feed-territory.
- **The DM-page event-listener wiring block** at app.js
  lines ~13270–13470 — search debounce, attach-menu wiring, file
  picker, paste handler, send-button override, keydown intercept.
  Reads + writes the 3 mutable state vars via the accessors.
  Should migrate to a `wireMessagesPage()` inside messages.js
  (follow-up).

## Specific concerns to verify

The patterns Codex has caught in Stages 5–8 that I want second eyes
on. Items 1–6 mirror the standard extraction risks; items 7–10 are
specific to Stage 9.

### 1. Unbound identifier reads

Pre-flight scanner (`scripts/scan-messages9a-undef.js`) only flagged
false positives (destructured `data`, `fetchErr`, `msgErr` from
Supabase `await` responses). But Codex has consistently caught one
or two real ones per stage. Please re-grep `js/app.js` for any of
the 82 moved names being used bare without an import — especially
inside large helpers I might have missed (e.g., the comments
panel handlers that link to DMs, the notification-routing path,
deep-link handlers, mobile-menu mirror).

### 2. Bare `currentUser` / `currentProfile` reads in moved fns

The codemod rewrites these to `_cfg.getCurrentUser()` /
`_cfg.getCurrentProfile()` wherever they appear as bare
identifier reads (not just calls). If any function escaped the
rewrite (e.g., because it's nested deep inside a closure the
codemod didn't enter), it'll silently look at `undefined`.

Please scan `js/messages.js` for any bare `currentUser` or
`currentProfile` reference that isn't part of a property name.
Expected count is 0.

### 3. Bare cross-feature helper calls

Same risk for the 11 CONFIG_DEPS (hideAllMainPages, openProfile,
setSidebarActive, stopVideoPlayer, confirmDialog, closeAllModals,
uploadImage, formatCompact, linkify, firstUrlInText, plus the
arrow-wrapper-replaced SECRET_LOCK calls). Please verify those
calls all go through `_cfg.X` in messages.js (except `SECRET_LOCK`
which is intra-module after 9B).

### 4. `dmState` live-binding sanity

This is the highest-risk Stage 9 pattern.  `dmState` was exported
as a `let` binding from messages.js; 54 read/write call sites in
remaining app.js code mutate it via field access (e.g.,
`dmState.activeConvId = X`, `dmState.messages.push(...)`,
`dmState.replyingTo = null`). Because both sides hold a reference
to the same object, field mutations propagate. But the moment
messages.js (or app.js) does `dmState = newObj` (reassignment),
the binding diverges.

Please confirm: (a) no code reassigns `dmState` (just mutates
fields), (b) all 54 app.js sites are reaches you'd actually want
sharing state rather than passing through accessors.

### 5. Accessor coverage for the 3 mutable state vars

app.js's DM wiring block at ~13270 was rewritten by `sed` to use
`getDmAttachMenuEl()` / `setDmAttachMenuEl()` etc. Sed-based
rewrites are fragile — please grep `js/app.js` for any remaining
bare `_dmAttachMenuEl`, `_dmPendingAttachment`, `_dmSearchTimer`
that the sed missed. Expected count: 0 (I checked, but you're
the second pair of eyes).

### 6. SECRET_LOCK IIFE relocation

The IIFE moved from app.js (line ~13398) to messages.js. App.js
still calls it via the read-only export at line ~13127
(`secretLockIsUnlocked = () => SECRET_LOCK.isUnlocked()`) and
visibility-change handler at ~13158. Please confirm:
- SECRET_LOCK initializes at messages.js module-load time (the
  IIFE runs once) — same lifetime as before, just owned by
  messages.js now
- The `localStorage.getItem(KEY_HASH)` calls inside the IIFE
  still read the same keys (we didn't accidentally rename
  KEY_HASH / KEY_SALT / SESSION_UNLOCKED)
- The `backgroundedAt` closure var keeps its state across calls
  (it's inside the IIFE so should — but worth a sanity check)

### 7. NEW — Optimistic reconciliation by client nonce (queued: #212)

`sendDmMessage` does an optimistic prepend with a client-generated
id, then matches the realtime INSERT by message body to swap the
optimistic bubble for the real row. Body-match is fragile: if two
identical messages send within the realtime window, the second
INSERT could swap the wrong bubble. Codex flagged this earlier
(task #212) — please re-confirm the issue is still present after
the extraction (it should be, since we didn't touch the logic) so
the priority of #212 stays accurate.

### 8. NEW — Realtime channel leak on nav-away (queued: #213)

`subscribeToThread` + `subscribeToPresenceAndTyping` create
channels in `dmState.realtimeChannel` + `dmState.presenceChannel`.
The teardown call is `teardownConversationSubscription` (from
messages-dock.js). Please confirm:
- The teardown call fires on `hideAllMainPages` → page transition
  (e.g., navigating from Messages to Books) — currently it does
  NOT (this was the #213 finding). The extraction didn't fix it;
  just calling it out so it doesn't get lost.
- `subscribeToInbox`'s channel teardown on sign-out also still
  runs (it's in `bootstrapDmBadge`'s reset path).

### 9. NEW — Secret-chat RLS gap (queued: #214)

`dmGetOrCreateSecretConv` + `sendDmMessage` for secret convos do
client-side validation that the other user is a mutual follow
(via `dmIsMutualFollow`). This is bypass-able with raw RPC calls.
Server-side RLS or RPC validation is the fix (task #214). Same
pre-existing issue; just flagging it so the extraction reviewer
doesn't think we introduced it.

### 10. NEW — DM wiring block migration follow-up

The block at app.js ~13270–13470 reads/writes the 3 mutable state
vars (`_dmAttachMenuEl`, `_dmPendingAttachment`, `_dmSearchTimer`)
through accessor pairs. The block itself should move into a
`wireMessagesPage()` initializer inside messages.js (matches the
Stage 8 `wireBooksPage` / `wireBookReader` pattern). Once that
lands, the 3 accessor pairs retire and state stays encapsulated.

Not in this commit — task #229 follow-up. Please flag if you
think it should block ship.

## What I'd love a second pair of eyes on

Hand-pick — you don't need to cover all 10. The highest-value
items are probably:

- **#4** (dmState live-binding mutability)
- **#5** (accessor coverage — sed rewrites)
- **#6** (SECRET_LOCK IIFE relocation correctness)
- **#3** (cross-feature helper coverage in messages.js)
- **#10** (wiring block migration — flag-only, defer ok)

The rest are observations Codex can confirm or dismiss.

## How to run / verify

```bash
node --check js/app.js && node --check js/messages.js   # both pass
bash scripts/pre-deploy-check.sh                        # passes (5 advisory warnings)
node scripts/scan-messages9a-undef.js                   # only false-positives
```

Then in the browser:

1. Open Messages from sidebar → conversation list loads
2. Click any conv → thread opens, realtime live (open in two
   tabs, send from tab A, see arrive in tab B)
3. Send a text message → optimistic bubble + real INSERT swap
4. Send an emoji via the picker → inserts at cursor
5. Attach a photo → preview strip, send → image bubble lands
6. Open GIF picker, pick a GIF, send → GIF bubble lands
7. Hover over a bubble → quick-react picker + hover menu (edit,
   delete, copy, reply)
8. Click the reply on a bubble → reply preview appears above
   composer; send → reply renders
9. Open conv ⋯ menu → archive / leave / mute / rename / members
10. Search "x" in the conv list → global message search results
11. New convo (1:1) → pick a follower → opens new thread
12. Secret tab → PIN gate prompts → unlock → secret convos visible
13. Mention `@u` in composer → mention dropdown appears
14. Sign out → sign in → conv list re-fetches; no stale state
15. Navigate from Messages to another tab → presence/typing channel
    teardown (currently broken per #213 — don't expect this to work)

## Pre-existing notes

These aren't bugs introduced by this commit — but context Codex
should know:

- `js/messages-dock.js` is the floating dock module from earlier
  in the session. It owns the shared data layer; messages.js
  imports its exports. No changes to the dock in Stage 9.
- The optimistic-reconciliation-by-body issue (#212), the channel
  leak (#213), and the secret-chat RLS gap (#214) are all queued
  follow-ups that pre-date this extraction.
- The DM wiring block follow-up (#229) is the main piece of the
  extraction story that didn't make it into Stage 9 itself.
