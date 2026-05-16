// ════════════════════════════════════════════════════════════════════════
// Selebox earnings — extracted from js/app.js as Stage 11A of the
// refactor roadmap (2026-05-16). This module owns the READ / RENDER
// layer of the creator Earnings page:
//   • showEarnings + switchEarningsTab + boot wiring (top of page)
//   • loadAuthorEarnings (parallel fetch of balance + earnings +
//     withdrawals + KYC), month-picker, finalized-only filtering
//   • Breakdown drill-down (summary + paginated transactions) for
//     Posts / Videos / Books tiles
//   • Render functions: totals, breakdown tiles, balance card,
//     recent earnings list with pagination, withdrawal history list
//     with pagination, status label, currency formatter
//
// What's NOT here yet (queued):
//   • Stage 11B (#250) — KYC + Payments Info form subsystem
//     (renderAuthorKycBanner, syncAuthorPayoutButton, fillPaymentsInfoForm,
//      uploadKycImage, wireKycUpload, applyPaymentsInfoLockState,
//      openPaymentInfoChangeModal, submitPaymentInfoChange — bridged
//     via _cfg until they land here).
//   • Stage 11C (#251) — Withdrawal request flow
//     (_renderWithdrawalFeePreview, submit handler, _isPioneerExempt,
//      _pioneerDaysRemaining — still in app.js; the submit handler
//     calls back into loadAuthorEarnings via the export).
//
// CAREFUL: this is pure code movement, not a rewrite. If you see
// something you want to "improve while you're here" — DON'T. Open a
// separate task. The whole point of the stage discipline is
// "translation, not interpretation."
//
// See REFACTOR_ROADMAP.md (Stage 11A section).
// ════════════════════════════════════════════════════════════════════════

import { supabase, escHTML, initials, toast, timeAgo } from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// app.js INJECTS the live functions when it calls initEarnings(config) at
// sign-in. Default no-ops keep the page alive if a caller fires before
// init. The KYC bridges (renderAuthorKycBanner / syncAuthorPayoutButton /
// fillPaymentsInfoForm) are temporary — they'll be replaced by intra-
// module calls once Stage 11B moves the KYC subsystem here too.
let _cfg = {
  getCurrentUser:           () => null,
  getCurrentProfile:        () => null,
  getWalletConfig:          () => ({}),
  setSidebarActive:         () => {},
  hideAllMainPages:         () => {},
  renderAuthorKycBanner:    () => {},
  syncAuthorPayoutButton:   () => {},
  fillPaymentsInfoForm:     () => {},
};

export function initEarnings(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// Lazy DOM ref — element exists in index.html. We resolve it on first
// use rather than at module-load time so this module imports cleanly
// even when imported before DOMContentLoaded (matches the pattern from
// videos.js Stage 7A).
let _earningsPage = null;
function earningsPageEl() {
  if (!_earningsPage) _earningsPage = document.getElementById('earningsPage');
  return _earningsPage;
}

export function showEarnings(forceReload = false) {
  _cfg.hideAllMainPages();
  const __ep = earningsPageEl();
  if (!__ep) return;
  __ep.style.display = 'block';
  history.pushState(null, '', '#earnings');
  _cfg.setSidebarActive('btnEarnings');
  // Default to the Earnings tab on every open
  switchEarningsTab('earnings');
  // Earnings reloads on every visit by default — withdrawal status changes
  // matter and the user expects the most recent figures. But if it's a quick
  // tab-flick (reload < 30 seconds ago), skip the network call.
  const now = Date.now();
  const stale = !window._earningsLoadedAt || (now - window._earningsLoadedAt) > 30_000;
  if (forceReload || stale) {
    loadAuthorEarnings();
    window._earningsLoadedAt = now;
  }
}

export function switchEarningsTab(name) {
  document.querySelectorAll('.earnings-tab').forEach(t => t.classList.toggle('active', t.dataset.etab === name));
  document.querySelectorAll('.earnings-tab-content').forEach(s => {
    s.style.display = s.dataset.etabContent === name ? 'block' : 'none';
  });
  // Pre-fill the Payments Info form when switched to (uses _authorKyc snapshot)
  if (name === 'payments') _cfg.fillPaymentsInfoForm();
}

// Month picker — wired once at module load. Changing the month re-renders
// the "This Month" tile + breakdown row from the cached data; no
// network round-trip needed. (Was at app.js:1975, moved here Stage 11A
// because it touches _selectedMonthYear + _renderMonthScopedBreakdown
// which are module-private to earnings.)
document.getElementById('earningsMonthPicker')?.addEventListener('change', (e) => {
  _selectedMonthYear = e.target.value || _currentMonthYearKey();
  _renderMonthScopedBreakdown();
});

document.querySelectorAll('.earnings-tab').forEach(t => {
  t.addEventListener('click', () => switchEarningsTab(t.dataset.etab));
});

// Sidebar entry point
document.getElementById('btnEarnings')?.addEventListener('click', () => showEarnings());

let _authorBalance = null;
let _authorKyc     = null;
// Earnings page state (May 2026 mobile-parity refresh)
// ───────────────────────────────────────────────────────────────
// `_allEarningsCache` and `_allWithdrawalsCache` retain the full
// fetched datasets so the month picker can re-filter without going
// back to the network. `_selectedMonthYear` is the picker's current
// value as a "YYYY-MM" string; null means "current month".
let _allEarningsCache    = [];
let _allWithdrawalsCache = [];
let _selectedMonthYear   = null;

export async function loadAuthorEarnings() {
  if (!_cfg.getCurrentUser()) return;
  // Note: the legacy #authorEarningsSection lives in the Author dashboard
  // and was removed. Earnings now lives in the dedicated #earningsPage.

  // Fire all four reads in parallel — pulls all earnings rows for the
  // breakdown calculation (small per-author dataset, fine to fetch in full).
  // Withdrawals limit bumped 20 → 200 to match mobile so the lifetime
  // total includes ALL paid-out / in-flight money (counting only the
  // latest 20 would under-report lifetime gross on heavy creators).
  const [balanceRes, earningsRes, withdrawalsRes, kycRes] = await Promise.all([
    supabase.rpc('author_balance_for', { p_author_id: _cfg.getCurrentUser().id }),
    supabase.from('author_earnings')
      // adjusted_net_php_minor + adjusted_net_coins added for the
      // earnings moderation state machine (Phase 1 — May 2026). When
      // status='adjusted' the adjusted_* fields hold the effective
      // amount; original net_* stays for audit.
      .select('id, source_type, source_id, gross_coins, share_pct, net_coins, net_php_minor, adjusted_net_coins, adjusted_net_php_minor, currency_used, status, available_at, created_at')
      .eq('author_id', _cfg.getCurrentUser().id)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase.from('author_withdrawals')
      .select('id, amount_coins, amount_php_minor, status, payout_method, requested_at, approved_at, paid_at, rejection_reason')
      .eq('author_id', _cfg.getCurrentUser().id)
      .order('requested_at', { ascending: false })
      .limit(200),
    supabase.from('author_kyc')
      .select('status, rejection_reason, submitted_at, reviewed_at')
      .eq('user_id', _cfg.getCurrentUser().id)
      .maybeSingle(),
  ]);

  _authorBalance        = balanceRes.data || { available_coins: 0, pending_coins: 0, available_php_minor: 0, pending_php_minor: 0 };
  _authorKyc            = kycRes.data || null;
  _allEarningsCache     = earningsRes.data || [];
  _allWithdrawalsCache  = withdrawalsRes.data || [];

  // Initialize the month picker to the current month on first paint
  // (subsequent renders preserve whatever the user picked).
  if (_selectedMonthYear === null) _selectedMonthYear = _currentMonthYearKey();

  _populateMonthPicker();
  renderAuthorEarningsBalance();
  renderEarningsTotals();      // new — Total + This Month tiles
  _renderMonthScopedBreakdown(); // breakdown now respects the picker

  // Recent earnings is paginated to keep the DOM small (creators with
  // thousands of rows + per-row title lookups would otherwise lag).
  // Render the current page; the helper itself does the title resolve
  // for the visible window.
  _renderRecentEarningsPage();

  _renderWithdrawalsPage();
  _cfg.renderAuthorKycBanner();
  _cfg.syncAuthorPayoutButton();
}

// "YYYY-MM" for the current month — the canonical default the picker
// starts at, matching mobile's behavior.
function _currentMonthYearKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Filter a list of earnings rows to a single "YYYY-MM" bucket using
// `available_at` (mirrors mobile — see lib/earnings-supabase.js line
// 119-121 comment block on why available_at not created_at).
function _filterEarningsByMonthYear(rows, monthYear) {
  if (!monthYear) return rows;
  const [yStr, mStr] = monthYear.split('-');
  const year = Number(yStr);
  const monthIndex = Number(mStr) - 1;
  if (!Number.isFinite(year) || !Number.isInteger(monthIndex)) return rows;
  const start = new Date(year, monthIndex, 1, 0, 0, 0).getTime();
  const end   = new Date(year, monthIndex + 1, 0, 23, 59, 59).getTime();
  return rows.filter((r) => {
    const t = new Date(r.available_at || r.created_at || 0).getTime();
    return t >= start && t <= end;
  });
}

// Build the month picker options from the earliest earning forward
// to the current month. Newest first so the picker opens to the
// current month by default. Re-populates idempotently on every
// loadAuthorEarnings since the underlying data may grow.
function _populateMonthPicker() {
  const sel = document.getElementById('earningsMonthPicker');
  if (!sel) return;

  // Find the earliest available_at across all cached earnings. Falls
  // back to "August 2025" (the platform's first month with author
  // earnings, matching mobile's hardcoded floor).
  let earliest = new Date(2025, 7, 1); // August = month index 7
  for (const r of _allEarningsCache) {
    const t = new Date(r.available_at || r.created_at || 0);
    if (!isNaN(t.getTime()) && t < earliest) earliest = t;
  }

  const now = new Date();
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const opts = [];
  // Walk from current month backwards to the earliest available.
  let cursor = new Date(cur.getFullYear(), cur.getMonth(), 1);
  while (cursor >= new Date(earliest.getFullYear(), earliest.getMonth(), 1)) {
    const y = cursor.getFullYear();
    const m = cursor.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    const label = `${monthNames[m]} ${y}`;
    opts.push(`<option value="${key}"${key === _selectedMonthYear ? ' selected' : ''}>${label}</option>`);
    cursor = new Date(y, m - 1, 1);
  }
  sel.innerHTML = opts.join('');
}

// Re-render the month-scoped pieces: This Month tile + breakdown.
// Lifetime total + balance cards are NOT month-sensitive.
function _renderMonthScopedBreakdown() {
  // Finalized-only rule (Phase 1.3 — May 14 earnings moderation):
  // Only verified or adjusted rows count toward Monthly Earnings +
  // breakdown. Pending (under review) and rejected are excluded.
  // Adjusted rows count at adjusted_net_php_minor.
  //
  // Phase 1.3 switched the gate from `available_at <= now()` to
  // `status IN ('verified','adjusted')`. The cron auto-promotes
  // pending → verified after the 7-day hold, so the two are
  // equivalent for normal flow. The status filter additionally
  // excludes admin-rejected rows even when their available_at has
  // passed.
  //
  // Legacy 'available' status is treated as verified (alias kept on
  // the CHECK constraint to avoid breaking older live RPCs).
  const monthFiltered = _filterEarningsByMonthYear(_allEarningsCache, _selectedMonthYear);
  const finalized = monthFiltered.filter((r) =>
    r.status === 'verified' || r.status === 'available' || r.status === 'adjusted'
  );
  // Project rows to use adjusted amounts when status='adjusted' so
  // the breakdown sums the effective (post-adjustment) value, not
  // the original. renderEarningsBreakdown reads `net_php_minor` and
  // `net_coins` directly, so we substitute those fields per-row.
  const projected = finalized.map((r) => {
    if (r.status !== 'adjusted') return r;
    return {
      ...r,
      net_php_minor: Number(r.adjusted_net_php_minor) >= 0 ? Number(r.adjusted_net_php_minor) : r.net_php_minor,
      net_coins:     Number(r.adjusted_net_coins)     >= 0 ? Number(r.adjusted_net_coins)     : r.net_coins,
    };
  });
  renderEarningsBreakdown(projected);
  // Also update the "This Month" tile total.
  const monthMinor = projected.reduce((sum, r) => sum + (r.net_php_minor || 0), 0);
  const monthEl = document.getElementById('earningsMonthPhp');
  if (monthEl) monthEl.textContent = formatPhpFromMinor(monthMinor);
  // Label updates to match the selected month for clarity.
  const labelEl = document.getElementById('earningsMonthLabel');
  if (labelEl) {
    labelEl.textContent = _selectedMonthYear === _currentMonthYearKey() ? 'This month' : 'Selected month';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Shared title resolver for any list of `author_earnings` rows. Used
// by BOTH the drill-down transaction view AND the main "Recent
// earnings" list. Resolves chapter / book_bulk / video / post titles
// in parallel and returns a Map<"<source_type>:<source_id>", title>.
//
// Posts get a short content excerpt since they have no `title`
// column. Returns "Untitled <thing>" as a defensive fallback.
//
// Partition-by-id-format: rows backfilled from Appwrite have hex
// `source_id`s that fail Postgres's UUID cast, so we split each id
// list into UUIDs (queried by `id`) and legacy hex (queried by
// `legacy_appwrite_id`). The combined `.or()` filter that mobile
// tried first silently returned zero rows for the legacy partition;
// two separate queries per kind sidestep the cast error entirely.
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function _resolveEarningsTitles(rows) {
  const titleByKey = new Map();
  if (!rows || !rows.length) return titleByKey;

  const partition = (ids) => {
    const uuids = [], legacy = [];
    for (const id of ids) { if (_UUID_RE.test(id)) uuids.push(id); else legacy.push(id); }
    return { uuids, legacy };
  };
  const setTitle = (key, label) => { if (label) titleByKey.set(key, label); };

  const chapterIds  = [...new Set(rows.filter(r => r.source_type === 'chapter').map(r => r.source_id))];
  const bookBulkIds = [...new Set(rows.filter(r => r.source_type === 'book_bulk').map(r => r.source_id))];
  const videoIds    = [...new Set(rows.filter(r => r.source_type === 'video').map(r => r.source_id))];
  const postIds     = [...new Set(rows.filter(r => r.source_type === 'post').map(r => r.source_id))];

  const tasks = [];

  if (chapterIds.length) {
    tasks.push((async () => {
      const { uuids, legacy } = partition(chapterIds);
      const handle = (rs) => (rs || []).forEach((row) => {
        const bookTitle    = row.books?.title || '';
        const chapterTitle = row.title || '';
        const label = bookTitle && chapterTitle
          ? `${bookTitle} — ${chapterTitle}`
          : chapterTitle || bookTitle || 'Untitled chapter';
        setTitle(`chapter:${row.id}`, label);
        if (row.legacy_appwrite_id) setTitle(`chapter:${row.legacy_appwrite_id}`, label);
      });
      const q = [];
      if (uuids.length)  q.push(supabase.from('chapters').select('id, title, legacy_appwrite_id, books(id, title)').in('id', uuids).then(({ data }) => handle(data)));
      if (legacy.length) q.push(supabase.from('chapters').select('id, title, legacy_appwrite_id, books(id, title)').in('legacy_appwrite_id', legacy).then(({ data }) => handle(data)));
      await Promise.all(q);
    })());
  }
  if (bookBulkIds.length) {
    tasks.push((async () => {
      const { uuids, legacy } = partition(bookBulkIds);
      const handle = (rs) => (rs || []).forEach((row) => {
        const label = row.title ? `${row.title} (full book)` : 'Untitled book (full)';
        setTitle(`book_bulk:${row.id}`, label);
        if (row.legacy_appwrite_id) setTitle(`book_bulk:${row.legacy_appwrite_id}`, label);
      });
      const q = [];
      if (uuids.length)  q.push(supabase.from('books').select('id, title, legacy_appwrite_id').in('id', uuids).then(({ data }) => handle(data)));
      if (legacy.length) q.push(supabase.from('books').select('id, title, legacy_appwrite_id').in('legacy_appwrite_id', legacy).then(({ data }) => handle(data)));
      await Promise.all(q);
    })());
  }
  if (videoIds.length) {
    tasks.push((async () => {
      const { uuids, legacy } = partition(videoIds);
      const handle = (rs) => (rs || []).forEach((row) => {
        const label = row.title || 'Untitled video';
        setTitle(`video:${row.id}`, label);
        if (row.legacy_appwrite_id) setTitle(`video:${row.legacy_appwrite_id}`, label);
      });
      const q = [];
      if (uuids.length)  q.push(supabase.from('videos').select('id, title, legacy_appwrite_id').in('id', uuids).then(({ data }) => handle(data)));
      if (legacy.length) q.push(supabase.from('videos').select('id, title, legacy_appwrite_id').in('legacy_appwrite_id', legacy).then(({ data }) => handle(data)));
      await Promise.all(q);
    })());
  }
  if (postIds.length) {
    // Posts have no `title` column — use a short excerpt from the
    // first non-empty line of `content` (or `caption` for legacy
    // rows). Mobile doesn't resolve post titles at all (shows
    // "Unknown item"); this small upgrade gives web a slightly
    // better empty-fallback without diverging from mobile data.
    tasks.push((async () => {
      const { uuids, legacy } = partition(postIds);
      const handle = (rs) => (rs || []).forEach((row) => {
        const raw = (row.content || row.caption || '').trim();
        const firstLine = raw.split(/\n/)[0] || '';
        const label = firstLine
          ? (firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine)
          : 'Post';
        setTitle(`post:${row.id}`, label);
        if (row.legacy_appwrite_id) setTitle(`post:${row.legacy_appwrite_id}`, label);
      });
      const q = [];
      if (uuids.length)  q.push(supabase.from('posts').select('id, content, caption, legacy_appwrite_id').in('id', uuids).then(({ data }) => handle(data)));
      if (legacy.length) q.push(supabase.from('posts').select('id, content, caption, legacy_appwrite_id').in('legacy_appwrite_id', legacy).then(({ data }) => handle(data)));
      await Promise.all(q);
    })());
  }

  await Promise.all(tasks);
  return titleByKey;
}

// Cache for the Recent earnings list. Populated by loadAuthorEarnings
// for the visible window so renderAuthorEarningsList can render
// titles synchronously without flicker.
let _earningsRecentTitles = new Map();

// Pagination state for the Recent earnings list. Default 10 per page
// — keeps the DOM cheap and the title resolver fast. User can bump
// to 20/50/100 via the picker; choice persists in localStorage.
const EARNINGS_RECENT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
let _earningsRecentPageIdx = 1;
let _earningsRecentPageSize = (() => {
  const stored = parseInt(localStorage.getItem('selebox_earnings_recent_page_size') || '10', 10);
  return EARNINGS_RECENT_PAGE_SIZE_OPTIONS.includes(stored) ? stored : 10;
})();

// Same pagination story for the Withdrawal history list — separate
// state so the two pickers don't interfere with each other.
const WITHDRAWALS_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
let _withdrawalsPageIdx = 1;
let _withdrawalsPageSize = (() => {
  const stored = parseInt(localStorage.getItem('selebox_withdrawals_page_size') || '10', 10);
  return WITHDRAWALS_PAGE_SIZE_OPTIONS.includes(stored) ? stored : 10;
})();

// ─────────────────────────────────────────────────────────────────────
// Pass C — Earnings breakdown drill-down (May 2026 mobile parity).
//
// Click a per-source tile (Posts / Videos / Books) on the Earnings
// page → opens a focused view showing a paginated transaction log
// for that category plus a summary card with coins / stars / unlock
// totals. Mirrors mobile's app/(payments)/earnings-breakdown.jsx +
// lib/earnings-supabase.js {getAuthorEarningsSummary,
// getAuthorEarningsTransactions}.
//
// State is local to this section; no module-globals leak beyond.
// ─────────────────────────────────────────────────────────────────────

const _BREAKDOWN_PAGE_SIZE = 15;
let _breakdownState = {
  category: null,   // 'post' | 'video' | 'book'
  label: '',        // header copy ("From Videos", etc.)
  monthYear: null,  // honors the Earnings page's month picker
  items: [],
  offset: 0,
  hasMore: false,
  loading: false,
};

// source_type fan-out — books are stored as TWO row variants
// (chapter unlock vs full-book bulk), mirroring mobile's mapping.
function _breakdownSourceTypes(category) {
  if (category === 'book')  return ['chapter', 'book_bulk'];
  if (category === 'video') return ['video'];
  if (category === 'post')  return ['post'];
  return [];
}

// Summary fetch — sums net_php_minor + gross_coins (split by
// currency) + row count across ALL rows matching the filter.
// Independent of pagination; the summary stays stable as the user
// scrolls. Limit cap = 20,000, same as mobile.
async function _fetchEarningsBreakdownSummary({ category, monthYear }) {
  const empty = { total_pesos: 0, total_coins: 0, total_stars: 0, total_unlocks: 0 };
  const sourceTypes = _breakdownSourceTypes(category);
  if (!_cfg.getCurrentUser() || sourceTypes.length === 0) return empty;

  let query = supabase
    .from('author_earnings')
    .select('net_php_minor, gross_coins, currency_used')
    .eq('author_id', _cfg.getCurrentUser().id)
    .in('source_type', sourceTypes)
    .limit(20000);

  if (monthYear) {
    const range = _parseMonthRange(monthYear);
    if (range) {
      query = query
        .gte('available_at', range.start.toISOString())
        .lte('available_at', range.end.toISOString());
    }
  }

  const { data, error } = await query;
  if (error) {
    console.warn('[earnings-breakdown] summary fetch failed:', error.message);
    return empty;
  }

  let pesosMinor = 0, coins = 0, stars = 0, unlocks = 0;
  for (const r of data || []) {
    pesosMinor += r.net_php_minor || 0;
    unlocks += 1;
    const amount = r.gross_coins || 0;
    if (r.currency_used === 'star') stars += amount;
    else coins += amount;
  }
  return {
    total_pesos: pesosMinor / 100,
    total_coins: coins,
    total_stars: stars,
    total_unlocks: unlocks,
  };
}

// "YYYY-MM" → { start, end } Date pair. Mirrors mobile's
// parseMonthYear in lib/earnings-supabase.js.
function _parseMonthRange(monthYear) {
  if (!monthYear) return null;
  const [yStr, mStr] = monthYear.split('-');
  const year = Number(yStr);
  const monthIndex = Number(mStr) - 1;
  if (!Number.isFinite(year) || !Number.isInteger(monthIndex)) return null;
  return {
    start: new Date(year, monthIndex, 1, 0, 0, 0),
    end:   new Date(year, monthIndex + 1, 0, 23, 59, 59),
  };
}

// Paginated transaction fetch — limit+1 rows so we can detect
// hasMore without a separate count query. Titles are resolved
// per-page (separate small queries against chapters / books /
// videos) so we never load thousands of titles up front.
async function _fetchEarningsBreakdownTransactions({ category, monthYear, limit = _BREAKDOWN_PAGE_SIZE, offset = 0 }) {
  const empty = { items: [], hasMore: false };
  const sourceTypes = _breakdownSourceTypes(category);
  if (!_cfg.getCurrentUser() || sourceTypes.length === 0) return empty;

  let query = supabase
    .from('author_earnings')
    .select('source_id, source_type, gross_coins, currency_used, net_php_minor, created_at, available_at')
    .eq('author_id', _cfg.getCurrentUser().id)
    .in('source_type', sourceTypes)
    .order('available_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit); // inclusive — +1 row probes hasMore

  if (monthYear) {
    const range = _parseMonthRange(monthYear);
    if (range) {
      query = query
        .gte('available_at', range.start.toISOString())
        .lte('available_at', range.end.toISOString());
    }
  }

  const { data: rows, error } = await query;
  if (error) {
    console.warn('[earnings-breakdown] transactions fetch failed:', error.message);
    return empty;
  }

  const all = rows || [];
  const hasMore = all.length > limit;
  const pageRows = hasMore ? all.slice(0, limit) : all;

  // Resolve titles for this page only. Same logic as mobile —
  // partition ids into UUIDs vs legacy Appwrite hex strings; legacy
  // hex would fail the `id` column's uuid cast, so we query by
  // `legacy_appwrite_id` for those.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const partition = (ids) => {
    const uuids = [], legacy = [];
    for (const id of ids) { if (UUID_RE.test(id)) uuids.push(id); else legacy.push(id); }
    return { uuids, legacy };
  };
  const titleByKey = new Map();
  const setTitle = (key, label) => { if (label) titleByKey.set(key, label); };

  const chapterIds = pageRows.filter(r => r.source_type === 'chapter').map(r => r.source_id);
  const bookBulkIds = pageRows.filter(r => r.source_type === 'book_bulk').map(r => r.source_id);
  const videoIds   = pageRows.filter(r => r.source_type === 'video').map(r => r.source_id);

  const tasks = [];

  if (chapterIds.length) {
    tasks.push((async () => {
      const { uuids, legacy } = partition(chapterIds);
      const handle = (rows) => (rows || []).forEach((row) => {
        const bookTitle = row.books?.title || '';
        const chapterTitle = row.title || '';
        const label = bookTitle && chapterTitle ? `${bookTitle} — ${chapterTitle}`
          : chapterTitle ? chapterTitle
          : bookTitle ? bookTitle
          : 'Untitled chapter';
        setTitle(`chapter:${row.id}`, label);
        if (row.legacy_appwrite_id) setTitle(`chapter:${row.legacy_appwrite_id}`, label);
      });
      const subqueries = [];
      if (uuids.length)  subqueries.push(supabase.from('chapters').select('id, title, legacy_appwrite_id, books(id, title)').in('id', uuids).then(({ data }) => handle(data)));
      if (legacy.length) subqueries.push(supabase.from('chapters').select('id, title, legacy_appwrite_id, books(id, title)').in('legacy_appwrite_id', legacy).then(({ data }) => handle(data)));
      await Promise.all(subqueries);
    })());
  }
  if (bookBulkIds.length) {
    tasks.push((async () => {
      const { uuids, legacy } = partition(bookBulkIds);
      const handle = (rows) => (rows || []).forEach((row) => {
        const label = row.title ? `${row.title} (full book)` : 'Untitled book (full)';
        setTitle(`book_bulk:${row.id}`, label);
        if (row.legacy_appwrite_id) setTitle(`book_bulk:${row.legacy_appwrite_id}`, label);
      });
      const subqueries = [];
      if (uuids.length)  subqueries.push(supabase.from('books').select('id, title, legacy_appwrite_id').in('id', uuids).then(({ data }) => handle(data)));
      if (legacy.length) subqueries.push(supabase.from('books').select('id, title, legacy_appwrite_id').in('legacy_appwrite_id', legacy).then(({ data }) => handle(data)));
      await Promise.all(subqueries);
    })());
  }
  if (videoIds.length) {
    tasks.push((async () => {
      const { uuids, legacy } = partition(videoIds);
      const handle = (rows) => (rows || []).forEach((row) => {
        const label = row.title || 'Untitled video';
        setTitle(`video:${row.id}`, label);
        if (row.legacy_appwrite_id) setTitle(`video:${row.legacy_appwrite_id}`, label);
      });
      const subqueries = [];
      if (uuids.length)  subqueries.push(supabase.from('videos').select('id, title, legacy_appwrite_id').in('id', uuids).then(({ data }) => handle(data)));
      if (legacy.length) subqueries.push(supabase.from('videos').select('id, title, legacy_appwrite_id').in('legacy_appwrite_id', legacy).then(({ data }) => handle(data)));
      await Promise.all(subqueries);
    })());
  }

  await Promise.all(tasks);

  const items = pageRows.map((r) => ({
    title: titleByKey.get(`${r.source_type}:${r.source_id}`) || 'Unknown item',
    amount: r.gross_coins || 0,
    currency: r.currency_used === 'star' ? 'star' : 'coin',
    pesos: (r.net_php_minor || 0) / 100,
    // created_at = real transaction time. DO NOT switch to
    // available_at — that's the vesting date, which is in the
    // FUTURE for rows still inside the hold window (would display
    // "May 21" for an unlock that actually happened on May 7).
    // Mobile hit this exact bug; comment block at lib/earnings-
    // supabase.js:601-616 documents the trap.
    created_at: r.created_at || r.available_at,
    source_id: r.source_id,
    source_type: r.source_type,
  }));

  return { items, hasMore };
}

// "May 5, 2026 · 3:42 PM"
function _formatBreakdownTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// Open the drill-down view for `category`. Loads summary + first
// page in parallel. Hides the main earnings tab content + tabs while
// open so the user gets a focused, full-page view.
export async function openEarningsBreakdown(category, label) {
  if (!_cfg.getCurrentUser()) return;
  const view = document.getElementById('earningsBreakdownView');
  if (!view) return;

  // Honor the current Earnings month picker — if "this month" is
  // selected we filter; if the user is on the current month and
  // nothing was filtered, monthYear stays as-is. Use the same
  // _selectedMonthYear shared with the parent page.
  _breakdownState = {
    category,
    label: label || 'Earnings',
    monthYear: _selectedMonthYear || null,
    items: [],
    offset: 0,
    hasMore: false,
    loading: true,
  };

  // Hide tabs + tab content; show drill-down view.
  document.querySelectorAll('#earningsPage .earnings-tabs, #earningsPage .earnings-tab-content').forEach(el => el.style.display = 'none');
  view.style.display = 'block';

  // Header — label + accent-colored icon for the chosen category
  document.getElementById('earningsBreakdownLabel').textContent = label;
  const iconWrap = document.getElementById('earningsBreakdownIcon');
  if (iconWrap) {
    iconWrap.dataset.category = category;
    iconWrap.innerHTML = _breakdownCategoryIcon(category);
  }

  // Loading skeleton in list + summary
  const list = document.getElementById('earningsBreakdownList');
  if (list) list.innerHTML = '<div class="earnings-breakdown-loading">Loading transactions…</div>';
  _renderEarningsBreakdownSummary({ total_pesos: 0, total_coins: 0, total_stars: 0, total_unlocks: 0 });

  // Parallel fetch
  const [sum, page] = await Promise.all([
    _fetchEarningsBreakdownSummary({ category, monthYear: _breakdownState.monthYear }),
    _fetchEarningsBreakdownTransactions({ category, monthYear: _breakdownState.monthYear, limit: _BREAKDOWN_PAGE_SIZE, offset: 0 }),
  ]);

  _renderEarningsBreakdownSummary(sum);
  _breakdownState.items   = page.items;
  _breakdownState.offset  = page.items.length;
  _breakdownState.hasMore = page.hasMore;
  _breakdownState.loading = false;
  _renderEarningsBreakdownList();
}

export function closeEarningsBreakdown() {
  const view = document.getElementById('earningsBreakdownView');
  if (view) view.style.display = 'none';
  document.querySelectorAll('#earningsPage .earnings-tabs').forEach(el => el.style.display = '');
  // Restore whichever tab was active when we opened. Default = earnings.
  document.querySelectorAll('#earningsPage .earnings-tab-content').forEach(el => {
    el.style.display = el.dataset.etabContent === 'earnings' ? 'block' : 'none';
  });
  // Make sure the Earnings tab is visually selected.
  document.querySelectorAll('#earningsPage .earnings-tab').forEach(t => t.classList.toggle('active', t.dataset.etab === 'earnings'));
}

export async function _loadMoreEarningsBreakdown() {
  const st = _breakdownState;
  if (!st.hasMore || st.loading) return;
  st.loading = true;
  const btn = document.getElementById('btnEarningsBreakdownMore');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  const page = await _fetchEarningsBreakdownTransactions({
    category: st.category,
    monthYear: st.monthYear,
    limit: _BREAKDOWN_PAGE_SIZE,
    offset: st.offset,
  });
  st.items = [...st.items, ...page.items];
  st.offset = st.items.length;
  st.hasMore = page.hasMore;
  st.loading = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
  _renderEarningsBreakdownList();
}

function _renderEarningsBreakdownSummary(sum) {
  const labelEl   = document.getElementById('earningsBreakdownSummaryLabel');
  const amountEl  = document.getElementById('earningsBreakdownSummaryAmount');
  const coinsEl   = document.getElementById('earningsBreakdownCoins');
  const starsEl   = document.getElementById('earningsBreakdownStars');
  const unlocksEl = document.getElementById('earningsBreakdownUnlocks');
  const unlocksLb = document.getElementById('earningsBreakdownUnlocksLabel');
  if (labelEl) {
    labelEl.textContent = _breakdownState.monthYear
      ? `Earnings · ${_humanizeMonthYear(_breakdownState.monthYear)}`
      : 'Lifetime earnings';
  }
  if (amountEl)  amountEl.textContent = '₱' + (sum.total_pesos || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (coinsEl)   coinsEl.textContent   = (sum.total_coins || 0).toLocaleString();
  if (starsEl)   starsEl.textContent   = (sum.total_stars || 0).toLocaleString();
  if (unlocksEl) unlocksEl.textContent = (sum.total_unlocks || 0).toLocaleString();
  if (unlocksLb) unlocksLb.textContent = (sum.total_unlocks === 1) ? 'unlock' : 'unlocks';
}

function _renderEarningsBreakdownList() {
  const list = document.getElementById('earningsBreakdownList');
  const pager = document.getElementById('earningsBreakdownPager');
  if (!list) return;
  if (_breakdownState.items.length === 0) {
    list.innerHTML = `
      <div class="earnings-breakdown-empty">
        <div class="earnings-breakdown-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>
        </div>
        <div class="earnings-breakdown-empty-title">No earnings yet for this category</div>
        <div class="earnings-breakdown-empty-sub">When readers unlock your ${_breakdownLabelLowerNoun(_breakdownState.category)}, entries will show here.</div>
      </div>
    `;
    if (pager) pager.style.display = 'none';
    return;
  }
  list.innerHTML = _breakdownState.items.map((it) => `
    <div class="earnings-breakdown-row">
      <div class="earnings-breakdown-row-text">
        <div class="earnings-breakdown-row-title" title="${escHTML(it.title)}">${escHTML(it.title)}</div>
        <div class="earnings-breakdown-row-date">${escHTML(_formatBreakdownTimestamp(it.created_at))}</div>
      </div>
      <div class="earnings-breakdown-row-amount">
        <span class="earnings-breakdown-row-num">+${(it.amount || 0).toLocaleString()}</span>
        ${it.currency === 'star'
          ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="#a855f7"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z"/></svg><span class="earnings-breakdown-row-suffix">${it.amount === 1 ? 'star' : 'stars'}</span>`
          : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#b45309" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/></svg><span class="earnings-breakdown-row-suffix">${it.amount === 1 ? 'coin' : 'coins'}</span>`
        }
      </div>
    </div>
  `).join('');
  if (pager) pager.style.display = _breakdownState.hasMore ? '' : 'none';
}

function _breakdownLabelLowerNoun(category) {
  if (category === 'post')  return 'posts';
  if (category === 'video') return 'videos';
  if (category === 'book')  return 'books';
  return 'content';
}

function _breakdownCategoryIcon(category) {
  // Returns an inline SVG matching the per-source tile glyph, sized
  // 18px to slot inside the breakdown header.
  if (category === 'post')  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  if (category === 'video') return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
  if (category === 'book')  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H12v18H4.5A2.5 2.5 0 0 1 2 17.5v-13z"/><path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H12v18h7.5a2.5 2.5 0 0 0 2.5-2.5v-13z"/></svg>';
  return '';
}

function _humanizeMonthYear(monthYear) {
  if (!monthYear) return '';
  const [y, m] = monthYear.split('-');
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${monthNames[Number(m) - 1] || ''} ${y}`;
}

// Lifetime total = available + under-review + every withdrawal still
// in flight or completed (pending/approved/paid). Excludes
// rejected/failed — those didn't take money out. Mirrors mobile math
// at lib/earnings-supabase.js:687-758. Critical: count `pending`
// withdrawals so the lifetime total doesn't artificially drop when an
// author requests a payout (Charles flagged this exact bug in mobile).
export function renderEarningsTotals() {
  // Charles 2026-05-15 spec — Total Earnings = finalized lifetime
  // earnings only. Under-review (pending_php_minor) earnings are
  // NOT yet earnings; they may be reversed in the 7-day hold
  // window. Pending is surfaced in the dedicated tile on this same
  // page so creators can see the pipeline without it inflating the
  // lifetime headline.
  //
  // Withdrawals (pending / approved / paid) still count because they
  // moved already-finalized money out of `available` into the
  // withdrawal pipeline — excluding them would make Total Earnings
  // mysteriously drop the moment a creator requested a payout.
  // Rejected / failed withdrawals are excluded (the money is back
  // in `available` and already counted there).
  const b = _authorBalance || {};
  const balanceMinor = b.available_php_minor || 0;
  const paidOutMinor = (_allWithdrawalsCache || [])
    .filter((w) => w.status === 'pending' || w.status === 'approved' || w.status === 'paid')
    .reduce((sum, w) => sum + (w.amount_php_minor || 0), 0);
  const lifetimeMinor = balanceMinor + paidOutMinor;
  const el = document.getElementById('earningsTotalLifetimePhp');
  if (el) el.textContent = formatPhpFromMinor(lifetimeMinor);
}

// Breakdown by source_type — Posts / Videos / Books (Books = chapter + book_bulk)
export function renderEarningsBreakdown(rows) {
  const totals = { posts: 0, videos: 0, books: 0 };
  const phpTotals = { posts: 0, videos: 0, books: 0 };
  for (const r of rows) {
    if (r.source_type === 'video')                                        { totals.videos += r.net_coins; phpTotals.videos += r.net_php_minor; }
    else if (r.source_type === 'chapter' || r.source_type === 'book_bulk'){ totals.books  += r.net_coins; phpTotals.books  += r.net_php_minor; }
    else if (r.source_type === 'post')                                    { totals.posts  += r.net_coins; phpTotals.posts  += r.net_php_minor; }
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('breakdownPostsCoins',  totals.posts.toLocaleString());
  set('breakdownVideosCoins', totals.videos.toLocaleString());
  set('breakdownBooksCoins',  totals.books.toLocaleString());
  set('breakdownPostsPhp',    formatPhpFromMinor(phpTotals.posts));
  set('breakdownVideosPhp',   formatPhpFromMinor(phpTotals.videos));
  set('breakdownBooksPhp',    formatPhpFromMinor(phpTotals.books));
}

export function renderAuthorEarningsBalance() {
  const b = _authorBalance || {};
  // ── Rate-locked at earning time ─────────────────────────────────────
  // available_php_minor and pending_php_minor are summed from author_earnings
  // rows, each of which snapshotted its coin_to_php_minor at the moment the
  // reader paid. So when admin changes the rate from ₱0.20 → ₱0.25, only
  // FUTURE earnings use the new rate. Existing balances are immune.
  const availMinor = b.available_php_minor || 0;
  const pendMinor  = b.pending_php_minor   || 0;

  document.getElementById('earningsAvailablePhp').textContent = formatPhpFromMinor(availMinor);
  document.getElementById('earningsPendingPhp').textContent   = formatPhpFromMinor(pendMinor);

  // Hold copy — driven by app_config.author_earnings_hold_days so web
  // and mobile stay aligned whenever the SQL knob changes (was 14d,
  // dropped to 7d May 2026). The previous hardcoded "1–3 days" went
  // stale the moment the SQL was flipped; now the only update needed
  // is the SQL row + page reload.
  const holdDays = Number(_cfg.getWalletConfig().author_earnings_hold_days) || 7;
  const foot = document.getElementById('earningsHoldFootnote');
  if (foot) {
    // Phase 5.3 — surface the review possibility alongside the hold
    // window so creators understand a small fraction of earnings may
    // be reduced or rejected after admin review. Paired with the
    // notification trigger from 5.1: any actual rejection/adjustment
    // produces an in-app notification with the reason, so creators
    // never have to guess why their balance moved (or didn't).
    foot.textContent = holdDays === 1
      ? "Verified earnings become available 1 day after they're earned. We may review unusual activity for accuracy."
      : `Verified earnings become available ${holdDays} days after they're earned. We may review unusual activity for accuracy.`;
  }

  // Minimum payout hint — show admin-configured floor, or ₱100 by default
  const minPayoutMinor = _cfg.getWalletConfig().min_payout_php_minor || 10000;
  const minHint = document.getElementById('earningsMinPayoutHint');
  if (minHint) minHint.textContent = `Minimum payout: ${formatPhpFromMinor(minPayoutMinor)}`;

  // Cache for the payout-button gate
  _authorBalance._computed_available_minor = availMinor;
  _authorBalance._computed_pending_minor   = pendMinor;

  // Latest-withdrawal status callout — mirrors mobile's colored-dot
  // "pending - ₱X.XX" / "approved - ₱X.XX" / "paid - ₱X.XX" badge
  // under the Available amount. Only renders when the latest
  // withdrawal is in-flight or recently completed; otherwise hidden.
  const wEl   = document.getElementById('earningsWithdrawalStatus');
  const wText = wEl?.querySelector('.author-earnings-withdrawal-text');
  const wDot  = wEl?.querySelector('.author-earnings-withdrawal-dot');
  const latest = (_allWithdrawalsCache || [])[0]; // newest-first per query order
  if (wEl && wText && wDot && latest && ['pending', 'approved', 'paid'].includes(latest.status)) {
    const amt = formatPhpFromMinor(latest.amount_php_minor || 0);
    wText.textContent = `${latest.status} · ${amt}`;
    // Reset previous state classes, then apply the current one. Each
    // state maps to a distinct color in CSS.
    wEl.classList.remove('is-pending', 'is-approved', 'is-paid');
    wEl.classList.add(`is-${latest.status}`);
    wEl.style.display = '';
  } else if (wEl) {
    wEl.style.display = 'none';
  }
}

export function formatPhpFromMinor(m) {
  return '₱' + (m / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Slice + render the current Recent-earnings page. Computes the
// page window from _earningsRecentPageIdx + _earningsRecentPageSize,
// renders rows immediately with placeholder labels, then resolves
// titles for the slice in the background and re-renders. Also
// renders/updates the pagination bar below the list.
function _renderRecentEarningsPage() {
  const all = _allEarningsCache || [];
  const total = all.length;
  const pageSize = _earningsRecentPageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (_earningsRecentPageIdx > totalPages) _earningsRecentPageIdx = totalPages;
  if (_earningsRecentPageIdx < 1) _earningsRecentPageIdx = 1;
  const start = (_earningsRecentPageIdx - 1) * pageSize;
  const end   = Math.min(start + pageSize, total);
  const slice = all.slice(start, end);

  // First paint: placeholder labels (source_type fallback).
  renderAuthorEarningsList(slice);

  // Title resolve in background, then second paint with real labels.
  // We MERGE into _earningsRecentTitles instead of replacing so
  // titles already resolved for previous pages don't get wiped.
  _resolveEarningsTitles(slice).then((titles) => {
    titles.forEach((v, k) => _earningsRecentTitles.set(k, v));
    renderAuthorEarningsList(slice);
  }).catch(() => { /* swallow — page keeps placeholder labels */ });

  _renderRecentEarningsPager({ total, totalPages, start, end });
}

// Pagination controls below the Recent earnings list — same shape as
// the Creator Studio pager (per-page pill picker + Prev/Next + range
// label). Targets a sibling container; creates it lazily on first call.
function _renderRecentEarningsPager({ total, totalPages, start, end }) {
  const listEl = document.getElementById('authorEarningsList');
  if (!listEl) return;
  let pager = document.getElementById('authorEarningsPager');
  if (!pager) {
    pager = document.createElement('div');
    pager.id = 'authorEarningsPager';
    pager.className = 'studio-pagination'; // reuse Studio pager styling
    listEl.parentNode.insertBefore(pager, listEl.nextSibling);
  }
  if (total === 0) {
    pager.style.display = 'none';
    return;
  }
  pager.style.display = '';
  pager.innerHTML = `
    <div class="studio-pagination-pagesize">
      <span class="studio-pagination-label">Rows per page</span>
      <div class="studio-pagesize-group" role="radiogroup" aria-label="Rows per page">
        ${EARNINGS_RECENT_PAGE_SIZE_OPTIONS.map(n => `
          <button type="button" class="studio-pagesize-option ${n === _earningsRecentPageSize ? 'is-selected' : ''}" data-earnings-pagesize="${n}" role="radio" aria-checked="${n === _earningsRecentPageSize ? 'true' : 'false'}">${n}</button>
        `).join('')}
      </div>
    </div>
    <div class="studio-pagination-nav">
      <span class="studio-pagination-info">${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} · Page ${_earningsRecentPageIdx} of ${totalPages}</span>
      <button type="button" class="studio-pagination-btn" data-earnings-page-action="prev" ${_earningsRecentPageIdx <= 1 ? 'disabled' : ''} title="Previous page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <button type="button" class="studio-pagination-btn" data-earnings-page-action="next" ${_earningsRecentPageIdx >= totalPages ? 'disabled' : ''} title="Next page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  `;
  pager.querySelectorAll('[data-earnings-pagesize]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = parseInt(btn.dataset.earningsPagesize, 10);
      if (!EARNINGS_RECENT_PAGE_SIZE_OPTIONS.includes(next) || next === _earningsRecentPageSize) return;
      _earningsRecentPageSize = next;
      _earningsRecentPageIdx = 1;
      localStorage.setItem('selebox_earnings_recent_page_size', String(next));
      _renderRecentEarningsPage();
    });
  });
  pager.querySelectorAll('[data-earnings-page-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.earningsPageAction;
      if (dir === 'prev') _earningsRecentPageIdx = Math.max(1, _earningsRecentPageIdx - 1);
      else if (dir === 'next') _earningsRecentPageIdx = _earningsRecentPageIdx + 1;
      _renderRecentEarningsPage();
      const list = document.getElementById('authorEarningsList');
      if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

export function renderAuthorEarningsList(rows) {
  const el = document.getElementById('authorEarningsList');
  if (!el) return;
  if (!rows.length) {
    // Copy aligned with mobile + post-May-2026 stars overhaul: both
    // currencies now earn for authors, so the message no longer
    // singles out coins.
    el.innerHTML = '<div class="page-empty-soft">No earnings yet. When readers unlock your work, you\'ll see entries here.</div>';
    return;
  }
  // currency_used was added with the May 2026 stars-earn-for-authors
  // overhaul. Older rows pre-migration default to 'coin' (the column has
  // a server-side default), so the fallback below is just defensive
  // against a row that somehow comes back with currency_used=null.
  //
  // The "type" line now shows the resolved item title (chapter /
  // book / video / post excerpt) instead of the bare source_type.
  // Source kind moves to a small label inside the sub-line so the
  // user still knows what kind of content earned the row, without
  // duplicating "Video" as the dominant label on every line.
  const sourceKindLabel = (st) => {
    if (st === 'chapter')   return 'Chapter';
    if (st === 'book_bulk') return 'Book';
    if (st === 'video')     return 'Video';
    if (st === 'post')      return 'Post';
    return st.replace('_', ' ');
  };
  el.innerHTML = rows.map(r => {
    const cur   = (r.currency_used || 'coin').toLowerCase();
    const label = cur === 'star' ? 'star' : 'coin';
    const resolvedTitle = _earningsRecentTitles.get(`${r.source_type}:${r.source_id}`)
      || sourceKindLabel(r.source_type); // first-paint fallback before titles resolve
    return `
    <div class="earnings-row">
      <div class="earnings-row-meta">
        <div class="earnings-row-type" title="${escHTML(resolvedTitle)}">${escHTML(resolvedTitle)}</div>
        <div class="earnings-row-sub">${escHTML(sourceKindLabel(r.source_type))} · ${timeAgo(r.created_at)} · ${r.share_pct}% share of ${r.gross_coins} ${label}${r.gross_coins === 1 ? '' : 's'}</div>
      </div>
      <div class="earnings-row-amount">+${r.net_coins} <small>${label}${r.net_coins === 1 ? '' : 's'}</small></div>
      <div class="earnings-row-php">${formatPhpFromMinor(r.net_php_minor)}</div>
      <div class="earnings-row-status earnings-row-status-${r.status}">${earningsStatusLabel(r)}</div>
    </div>`;
  }).join('');
}

export function earningsStatusLabel(r) {
  if (r.status === 'pending') {
    const ms = new Date(r.available_at) - Date.now();
    if (ms <= 0) return 'Available';
    const days = Math.ceil(ms / 86400000);
    return `Pending · ${days}d`;
  }
  if (r.status === 'available') return 'Available';
  if (r.status === 'withdrawn') return 'Withdrawn';
  if (r.status === 'reversed')  return 'Reversed';
  return r.status;
}

// Slice + render the current Withdrawal history page. Mirrors the
// Recent-earnings paginator: caps DOM cost, persists user's pick.
function _renderWithdrawalsPage() {
  const all = _allWithdrawalsCache || [];
  const total = all.length;
  const pageSize = _withdrawalsPageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (_withdrawalsPageIdx > totalPages) _withdrawalsPageIdx = totalPages;
  if (_withdrawalsPageIdx < 1) _withdrawalsPageIdx = 1;
  const start = (_withdrawalsPageIdx - 1) * pageSize;
  const end   = Math.min(start + pageSize, total);
  const slice = all.slice(start, end);

  renderAuthorWithdrawalsList(slice);
  _renderWithdrawalsPager({ total, totalPages, start, end });
}

function _renderWithdrawalsPager({ total, totalPages, start, end }) {
  const listEl = document.getElementById('authorWithdrawalsList');
  if (!listEl) return;
  let pager = document.getElementById('authorWithdrawalsPager');
  if (!pager) {
    pager = document.createElement('div');
    pager.id = 'authorWithdrawalsPager';
    pager.className = 'studio-pagination';
    listEl.parentNode.insertBefore(pager, listEl.nextSibling);
  }
  if (total === 0) {
    pager.style.display = 'none';
    return;
  }
  pager.style.display = '';
  pager.innerHTML = `
    <div class="studio-pagination-pagesize">
      <span class="studio-pagination-label">Rows per page</span>
      <div class="studio-pagesize-group" role="radiogroup" aria-label="Rows per page">
        ${WITHDRAWALS_PAGE_SIZE_OPTIONS.map(n => `
          <button type="button" class="studio-pagesize-option ${n === _withdrawalsPageSize ? 'is-selected' : ''}" data-withdrawals-pagesize="${n}" role="radio" aria-checked="${n === _withdrawalsPageSize ? 'true' : 'false'}">${n}</button>
        `).join('')}
      </div>
    </div>
    <div class="studio-pagination-nav">
      <span class="studio-pagination-info">${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} · Page ${_withdrawalsPageIdx} of ${totalPages}</span>
      <button type="button" class="studio-pagination-btn" data-withdrawals-page-action="prev" ${_withdrawalsPageIdx <= 1 ? 'disabled' : ''} title="Previous page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <button type="button" class="studio-pagination-btn" data-withdrawals-page-action="next" ${_withdrawalsPageIdx >= totalPages ? 'disabled' : ''} title="Next page">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  `;
  pager.querySelectorAll('[data-withdrawals-pagesize]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = parseInt(btn.dataset.withdrawalsPagesize, 10);
      if (!WITHDRAWALS_PAGE_SIZE_OPTIONS.includes(next) || next === _withdrawalsPageSize) return;
      _withdrawalsPageSize = next;
      _withdrawalsPageIdx = 1;
      localStorage.setItem('selebox_withdrawals_page_size', String(next));
      _renderWithdrawalsPage();
    });
  });
  pager.querySelectorAll('[data-withdrawals-page-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.withdrawalsPageAction;
      if (dir === 'prev') _withdrawalsPageIdx = Math.max(1, _withdrawalsPageIdx - 1);
      else if (dir === 'next') _withdrawalsPageIdx = _withdrawalsPageIdx + 1;
      _renderWithdrawalsPage();
      const list = document.getElementById('authorWithdrawalsList');
      if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

export function renderAuthorWithdrawalsList(rows) {
  const el = document.getElementById('authorWithdrawalsList');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="page-empty-soft">No withdrawals yet.</div>';
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="earnings-row earnings-row-withdrawal">
      <div class="earnings-row-meta">
        <div class="earnings-row-type">Payout · ${escHTML(r.payout_method)}</div>
        <div class="earnings-row-sub">Requested ${timeAgo(r.requested_at)}${r.paid_at ? ' · Paid ' + timeAgo(r.paid_at) : ''}${r.rejection_reason ? ' · Reason: ' + escHTML(r.rejection_reason) : ''}</div>
      </div>
      <div class="earnings-row-amount">${r.amount_coins.toLocaleString()} <small>coins</small></div>
      <div class="earnings-row-php">${formatPhpFromMinor(r.amount_php_minor)}</div>
      <div class="earnings-row-status earnings-row-status-w-${r.status}">${escHTML(r.status)}</div>
    </div>
  `).join('');
}

// ─── Getter exports for the still-in-app.js KYC + withdrawal handlers ──
// `_authorBalance` and `_authorKyc` are populated by loadAuthorEarnings
// (after the 4-RPC parallel fetch) and read by syncAuthorPayoutButton
// + the btnRequestPayout click handler — both still in app.js until
// Stages 11B (#250) and 11C (#251) extract them. Expose readers here;
// the handlers will become intra-module accesses once those stages
// land in this file.
export function getAuthorBalance() { return _authorBalance; }
export function getAuthorKyc()     { return _authorKyc; }

// Re-export the title resolver for the wallet history block in app.js
// (lines ~2123, 2140) that maps ledger debit rows back to chapter /
// book / video titles. The wallet history is its own subsystem
// (Stage 13 #245) and currently borrows our resolver via this export.
export { _resolveEarningsTitles as resolveEarningsTitles };
