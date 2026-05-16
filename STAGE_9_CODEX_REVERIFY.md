# Stage 9 — Re-verification Brief (after first Codex review)

Quick follow-up: all 6 findings from the first Stage 9 review have
been addressed. This brief maps each finding to its fix so you can
verify per-item instead of re-reviewing the whole module.

## What you flagged → what landed

### Finding 1 (P0) — `setDmSearchTimer` missing `)`

**Was:** `js/app.js:13404` failed `node --input-type=module -e
"import('./js/app.js')"` with `SyntaxError: missing ) after argument
list`.

**Fixed at:** `js/app.js:13414`. Added the trailing `)` so the
sed-rewritten line now reads:

```js
  }, 280));
```

Same module-import check now succeeds; the only output is the harmless
`MODULE_TYPELESS_PACKAGE_JSON` warning that comes from `package.json`
not declaring `"type": "module"` (unrelated to the extraction).

### Finding 2 (P0/P1) — 8 app-local symbols referenced by messages.js

**Was:** ReferenceErrors at runtime for `_mentionDropdown`,
`_mentionTextarea`, `_mentionResults`, `_mentionIdx`, `_mentionDebounce`,
`DM_BUCKET`, `DM_GIPHY_KEY`, `DM_EMOJI_GROUPS`. The codemod's
EXTRACT_STATE list missed them when the moving functions' callees
came along.

**Fixed at:** moved all 8 declarations from `js/app.js` →
`js/messages.js`:

- 5 mention vars now declared in messages.js' Stage 9B module-state
  block (right above `// ─── Mention dropdown state ──`).
- `DM_BUCKET` + `DM_GIPHY_KEY` declared in the new attach/GIF/emoji
  constants block (with a note that `DM_MAX_IMAGE_BYTES` stayed in
  app.js because the file-picker handler — still part of the DM
  wiring block in app.js — passes it as an argument to
  `compressImageToJpeg`).
- `DM_EMOJI_GROUPS` declared alongside.

Verification grep:
```bash
for sym in _mentionDropdown _mentionTextarea _mentionResults _mentionIdx _mentionDebounce DM_BUCKET DM_GIPHY_KEY DM_EMOJI_GROUPS; do
  inApp=$(grep -cE "^(let|const|var) ${sym}\b" js/app.js || true)
  inMsg=$(grep -cE "^(let|const|var) ${sym}\b" js/messages.js || true)
  printf "%-22s app.js: %s  messages.js: %s\n" "$sym" "$inApp" "$inMsg"
done
```
All 8 now show `app.js: 0  messages.js: 1`.

### Finding 3 (P1) — `openReportUserModal` + `renderLinkPreview` need bridging

**Was:** Bare calls in messages.js at lines 2102 + 3452. The codemod's
CONFIG_DEPS list missed both. Both still live in app.js.

**Fixed at:**
- Added `openReportUserModal: () => {}` + `renderLinkPreview: () => ''`
  to messages.js' `_cfg` defaults block (right after `firstUrlInText`).
- Sed-rewrote the 2 bare call sites to `_cfg.openReportUserModal(...)`
  and `_cfg.renderLinkPreview(...)`.
- Wired both into `initMessages({...})` in app.js (alongside
  `firstUrlInText`).

Verification: `grep -n "_cfg.\(openReportUserModal\|renderLinkPreview\)" js/messages.js`
returns the 2 expected call sites; no bare calls remain.

### Finding 4 (P1) — Secret tab crashes on `SECRET_LOCK.renderGateHtml()`

**Was:** `js/messages.js:577` called `SECRET_LOCK.renderGateHtml()` which
doesn't exist — the actual function is the top-level
`renderSecretLockGateHtml`. My initMessages-era arrow wrapper had hidden
the bug at extraction time.

**Fixed at:** `js/messages.js:577` now calls
`renderSecretLockGateHtml()` directly (both functions live in the same
module now so no bridge needed).

Also cleaned up `js/app.js:13235` — dead const
`secretLockIsUnlocked = () => SECRET_LOCK.isUnlocked()` removed (it
was an unused pre-9B bridge wrapper; the only remaining direct
SECRET_LOCK access in app.js is the visibilitychange listener which
already calls `SECRET_LOCK.onVisibilityChange()` correctly).

### Finding 5 (P1) — Non-text sends bypass guards

**Was:** `sendDmThumbsUp` had no single-flight lock and no secret-mutual
re-check. `sendDmAttachment` had the same gap. `sendDmGif` is funneled
through `sendDmAttachment` via the pending-attachment kind, so fixing
attachment fixes GIF.

**Fixed at:** extracted two shared helpers in messages.js near
`sendDmMessage`:

```js
async function _dmCanSendInActiveConv() {
  if (!dmState.activeConvId) return false;
  const ac = dmState.activeConv;
  if (ac && ac.is_secret && !ac.is_group) {
    const otherId = ac.user_a === _cfg.getCurrentUser().id ? ac.user_b : ac.user_a;
    if (otherId) {
      const stillMutual = await dmIsMutualFollow(_cfg.getCurrentUser().id, otherId);
      if (!stillMutual) {
        toast('You and this person are no longer mutuals. Secret chat is frozen.', 'error');
        return false;
      }
    }
  }
  return true;
}

async function _dmWithSendLock(fn) {
  if (_dmSendInFlight) return false;
  _dmSendInFlight = true;
  try { await fn(); }
  finally { _dmSendInFlight = false; }
  return true;
}
```

Applied:
- `sendDmThumbsUp` — wrapped the insert body in
  `await _dmWithSendLock(async () => { ... })`, preceded by
  `if (!await _dmCanSendInActiveConv()) return;`.
- `sendDmAttachment` — added `if (!await _dmCanSendInActiveConv()) return false;`
  + `if (_dmSendInFlight) return false; _dmSendInFlight = true;` at the
  top. Wrapped the body in `try { ... } finally { _dmSendInFlight = false; }`
  so the lock releases on every exit path (4 early returns inside the
  try + the success return).
- `sendDmMessage` keeps its existing per-exit-path
  `releaseSendLock()` calls — it predates the helpers and already
  routes correctly.
- `sendDmGif` → enters via the pending-attachment kind on
  `sendDmAttachment`, so the new guards cover it too.

### Finding 6 (P2) — #213 channel leak on nav-away

**Was:** `hideAllMainPages()` hid the Messages page but didn't tear
down `dmState.realtimeChannel` / `presenceChannel`. Pre-existing #213.

**Fixed at:** added exported `teardownActiveConversation()` in
messages.js right above `subscribeToThread`:

```js
export function teardownActiveConversation() {
  if (dmState.realtimeChannel) { supabase.removeChannel(dmState.realtimeChannel); dmState.realtimeChannel = null; }
  if (dmState.presenceChannel) { supabase.removeChannel(dmState.presenceChannel); dmState.presenceChannel = null; }
  if (dmState.otherTypingTimer) { clearTimeout(dmState.otherTypingTimer); dmState.otherTypingTimer = null; }
  if (dmState.myTypingTimer)    { clearTimeout(dmState.myTypingTimer);    dmState.myTypingTimer = null; }
  dmState.otherIsTyping = false;
  dmState.otherIsOnline = false;
  dmState.activeConvId  = null;
  dmState.activeConv    = null;
  dmState.activeOther   = null;
}
```

Imported in app.js. `hideAllMainPages` now calls it only when
`messagesPage.style.display !== 'none'` — safe no-op when no
conversation was active.

Task #213 marked completed.

## Quick checks for you to run

```bash
node --check js/app.js && node --check js/messages.js
node --input-type=module -e "import('./js/app.js').then(() => console.log('OK'))"
bash scripts/pre-deploy-check.sh
```

All three should pass. The third has 5 advisory warnings (same set as
Stage 8 review) — none new from this fix pass.

## What I'd still love you to look at

The 6 fixes above are the spot fixes. Two structural notes for your
verification pass:

1. **Accessor pairs are still in place.** `getDmAttachMenuEl` +
   `setDmAttachMenuEl`, `getDmPendingAttachment` + setter,
   `getDmSearchTimer` + setter — these are still exported because the
   DM event-listener block at `app.js:~13270+` still mutates them.
   The proper fix (move the wiring block into a `wireMessagesPage()`
   inside messages.js) is queued as #229 and intentionally not in
   this commit.

2. **Two pre-existing issues still queued, not addressed in this
   pass:**
   - #212 — DM optimistic reconciliation by nonce (you flagged the
     body-match fragility earlier; behavior unchanged from
     extraction).
   - #214 — Server-side secret-chat validation behind RLS
     (`dmIsMutualFollow` is still client-side only; needs DB
     migration work).

Both are listed in the post-Stage-9 task tracker. Flagging here so
they don't get re-attributed to the fix pass.

## Net delta since the first review

- `js/app.js` line count net change: small reduction (the dead const +
  the 3 dead module-state declarations dropped). No functional
  removals from app.js — just the symbol-ownership cleanup the
  codemod missed.
- `js/messages.js` line count: up ~70 lines (the 8 declarations that
  moved + the two new send-guard helpers + the new
  `teardownActiveConversation` export).
- `_cfg` bridge surface: +2 entries (`openReportUserModal`,
  `renderLinkPreview`).
- New exports from messages.js: `teardownActiveConversation` (1
  function).
- No structural changes — same module shape, same accessor pattern,
  same 9-stage roadmap status.

If the re-verification finds anything else, send it back and I'll
patch the same way.
