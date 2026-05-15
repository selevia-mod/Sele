#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Selebox pre-deploy guard — runs static checks against HTML + JS before
# `git push` so the regressions that bit us repeatedly through 2026-05-15
# (Day 2 deploy day) become impossible to ship blind:
#
#   ┌────────────────────────────────────┬───────────────────────────────┐
#   │ Failure mode                       │ How this script catches it    │
#   ├────────────────────────────────────┼───────────────────────────────┤
#   │ Two HTML elements share id="X"     │ §1 dup-id sweep over *.html   │
#   │ Two JS `function foo()` decls      │ §2 dup-function-name sweep    │
#   │ Unclosed brace / typo blacks site  │ §3 `node --check` per *.js    │
#   │ Reference to nonexistent function  │ §4 best-effort orphan-call    │
#   │ Stale TODO / FIXME / placeholder   │ §5 placeholder sweep          │
#   └────────────────────────────────────┴───────────────────────────────┘
#
# Usage
# ─────
#   $ bash scripts/pre-deploy-check.sh
#   $ ./scripts/pre-deploy-check.sh        (after `chmod +x`)
#
# Exit codes
# ──────────
#   0  → all checks passed, safe to push
#   1  → at least one check failed; review the printed report
#   2  → script-level error (missing tool, etc.)
#
# Optional git hook
# ─────────────────
#   Symlink this to .git/hooks/pre-push so it runs automatically:
#     ln -sf ../../scripts/pre-deploy-check.sh .git/hooks/pre-push
#   Override with `git push --no-verify` if you need to bypass.
# ════════════════════════════════════════════════════════════════════════

set -u                                  # surface unset-var bugs

# Resolve the repo root reliably whether this script is invoked
# directly (`./scripts/pre-deploy-check.sh`) OR via the git pre-push
# symlink (`.git/hooks/pre-push`). git rev-parse always returns the
# repo top-level regardless of CWD or symlink path. Fall back to the
# legacy `dirname` resolution if git isn't on PATH (very unusual).
if command -v git >/dev/null 2>&1 && ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  : # ROOT is set
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT" || { echo "Can't cd to repo root"; exit 2; }

# ─── ANSI styling (turned off when not a tty so CI logs stay clean) ───
if [[ -t 1 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); CYAN=$(tput setaf 6)
else
  BOLD=""; DIM=""; RESET=""; RED=""; GREEN=""; YELLOW=""; CYAN=""
fi

FAIL_COUNT=0
WARN_COUNT=0

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "${RED}${BOLD}✗${RESET} $*"
}
warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  echo "${YELLOW}${BOLD}⚠${RESET} $*"
}
pass() {
  echo "${GREEN}${BOLD}✓${RESET} $*"
}
section() {
  echo
  echo "${CYAN}${BOLD}── $* ──${RESET}"
}

# Files to scan. Add more as the project grows.
HTML_FILES=(index.html admin.html)
JS_FILES=(js/app.js js/admin.js)

# ════════════════════════════════════════════════════════════════════════
# §1. Duplicate HTML id="..." sweep
# ────────────────────────────────────
# Catches the bug where two elements share an id and getElementById picks
# the first one — every listener attached to id="X" lands on the wrong
# element. Real example from 2026-05-15: composer's submit Post button
# AND the sidebar nav button both had id="btnPost".
# ════════════════════════════════════════════════════════════════════════
section "1. Duplicate HTML id sweep"
for f in "${HTML_FILES[@]}"; do
  [[ -f "$f" ]] || { warn "skipped (missing): $f"; continue; }
  # Strip HTML comments before scanning so comment-mentioned IDs
  # (e.g. "<!-- See id='foo' in line 123 -->") don't false-positive.
  # `perl -0777 -pe` slurps the file and removes /<!--.*?-->/gs.
  # If perl isn't available, fall back to a leaky scan with a warning.
  if command -v perl >/dev/null 2>&1; then
    stripped=$(perl -0777 -pe 's/<!--.*?-->//gs' "$f")
  else
    stripped=$(cat "$f")
    warn "perl not found — comment stripping disabled, id check may false-positive on commented examples"
  fi
  # Extract every `id="..."` value from the comment-stripped HTML, sort,
  # find duplicates.
  dups=$(echo "$stripped" \
           | grep -oE 'id="[^"]+"' \
           | sed -E 's/^id="(.*)"$/\1/' \
           | sort | uniq -d)
  if [[ -z "$dups" ]]; then
    pass "$f: no duplicate IDs"
  else
    fail "$f: duplicate id values:"
    while IFS= read -r dup; do
      # Re-grep the original file (with comments) so the line numbers
      # the user sees in their editor match. Filter out comment lines
      # so they don't bloat the report.
      grep -n "id=\"$dup\"" "$f" | grep -v '<!--' | sed "s|^|    ${DIM}|; s|\$|${RESET}|"
    done <<< "$dups"
  fi
done

# ════════════════════════════════════════════════════════════════════════
# §2. Duplicate top-level `function foo()` declarations
# ────────────────────────────────────────────────────────
# Catches the bug where two functions share a name in the same file —
# the second declaration silently overrides the first in module scope,
# but in some load paths (top-level `function` in a `<script type=
# "module">`) it raises "Identifier already declared" and BLACK-SCREENS
# the entire site. Real example from 2026-05-15: my new
# `renderVideoCard` collided with the legacy one 14,000 lines away.
# ════════════════════════════════════════════════════════════════════════
section "2. Duplicate JS function declarations"
for f in "${JS_FILES[@]}"; do
  [[ -f "$f" ]] || { warn "skipped (missing): $f"; continue; }
  # `^function NAME(` matches top-level function declarations only.
  # Arrow functions / methods / nested decls are skipped. -E for ERE,
  # capture-group `([A-Za-z_$][A-Za-z0-9_$]*)` covers all valid JS
  # identifiers including $-prefixed.
  dups=$(grep -nE '^function [A-Za-z_$][A-Za-z0-9_$]*\(' "$f" \
           | sed -E 's/^([0-9]+):function ([A-Za-z_$][A-Za-z0-9_$]*)\(.*$/\2 @line \1/' \
           | awk '{print $1}' \
           | sort | uniq -d)
  if [[ -z "$dups" ]]; then
    pass "$f: no duplicate function names"
  else
    fail "$f: duplicate function declarations:"
    while IFS= read -r name; do
      grep -nE "^function $name\(" "$f" | sed "s|^|    ${DIM}|; s|\$|${RESET}|"
    done <<< "$dups"
  fi
done

# ════════════════════════════════════════════════════════════════════════
# §3. JavaScript syntax check
# ────────────────────────────────
# `node --check` parses the file and exits non-zero on any syntax error.
# Catches unclosed braces, unterminated strings, typos. Fast (~200ms per
# file). If node isn't installed, we skip with a warning so this never
# blocks a push entirely — but we'd rather you install node.
# ════════════════════════════════════════════════════════════════════════
section "3. JavaScript syntax check"
if ! command -v node >/dev/null 2>&1; then
  warn "node not found — skipping syntax check. Install Node to enable."
else
  for f in "${JS_FILES[@]}"; do
    [[ -f "$f" ]] || { warn "skipped (missing): $f"; continue; }
    if node --check "$f" 2>/tmp/seleb-pre-deploy-syntax-err; then
      pass "$f: syntax OK"
    else
      fail "$f: syntax error:"
      sed "s|^|    ${DIM}|; s|\$|${RESET}|" /tmp/seleb-pre-deploy-syntax-err
    fi
  done
  rm -f /tmp/seleb-pre-deploy-syntax-err
fi

# ════════════════════════════════════════════════════════════════════════
# §4. Best-effort orphan-call sweep
# ──────────────────────────────────
# Warns (does NOT fail) about calls to functions that don't appear to be
# defined anywhere in the JS files. Limited to identifiers prefixed with
# common patterns (open*/show*/load*/render*) since a full call-graph
# walk is out of scope. False positives expected for browser globals
# (alert, confirm, etc.) — that's why this is a WARN, not a FAIL.
# ════════════════════════════════════════════════════════════════════════
section "4. Orphan-call sweep (best-effort)"
TMP_DEFS=$(mktemp)
TMP_CALLS=$(mktemp)
trap 'rm -f "$TMP_DEFS" "$TMP_CALLS"' EXIT

# Defined symbols — match every realistic JS declaration pattern:
#   function foo()                  ─ classic top-level
#   async function foo()            ─ async variant
#   const foo = ...                 ─ const arrow / function expr
#   let foo = ...
#   var foo = ...
#   window.foo = ...                ─ explicit global
#   foo: function()                 ─ object method shorthand
# Anywhere in the file (not just line start), to catch nested helpers.
for f in "${JS_FILES[@]}"; do
  [[ -f "$f" ]] || continue
  {
    # `function foo(` / `async function foo(`
    grep -hoE '(^|[^A-Za-z0-9_$])(async +)?function +[A-Za-z_$][A-Za-z0-9_$]*' "$f" \
      | sed -E 's/.*function +//'
    # `const foo =` / `let foo =` / `var foo =`
    grep -hoE '(^|[^A-Za-z0-9_$])(const|let|var) +[A-Za-z_$][A-Za-z0-9_$]*' "$f" \
      | sed -E 's/.*(const|let|var) +//'
    # `window.foo =`
    grep -hoE 'window\.[A-Za-z_$][A-Za-z0-9_$]*' "$f" \
      | sed -E 's/^window\.//'
    # `foo: function` (object method)
    grep -hoE '[A-Za-z_$][A-Za-z0-9_$]*: *(async +)?function' "$f" \
      | sed -E 's/: *.*//'
  } >> "$TMP_DEFS"
done

# Calls to identifiers matching open*/show*/load*/render*. Strip the
# `(` and any leading punctuation so the call-name matches the bare
# def-name from TMP_DEFS. Sort + uniq for clean diff.
for f in "${JS_FILES[@]}"; do
  [[ -f "$f" ]] || continue
  grep -hoE '\b(open|show|load|render)[A-Z][A-Za-z0-9_$]*\(' "$f" \
    | sed -E 's/\(//' >> "$TMP_CALLS"
done

# Browser/library globals that legitimately match the open*/show*/etc.
# pattern but aren't defined in our JS — pre-seed the defs list so
# they don't false-positive. Add to this list as the project grows.
KNOWN_GLOBALS=(
  open openModal openConfirm openPlayer openSession openProfile
  showModal showToast showAlert showConfirm showDialog showFeed
  loadScript renderScene renderUI
)
printf '%s\n' "${KNOWN_GLOBALS[@]}" >> "$TMP_DEFS"

orphans=$(comm -23 <(sort -u "$TMP_CALLS") <(sort -u "$TMP_DEFS") | head -20)
if [[ -z "$orphans" ]]; then
  pass "no obvious orphan calls"
else
  warn "${BOLD}possibly-undefined functions (review — may include false positives):${RESET}"
  echo "$orphans" | sed "s|^|    ${DIM}|; s|\$|${RESET}|"
fi

# ════════════════════════════════════════════════════════════════════════
# §5. Placeholder / TODO sweep
# ──────────────────────────────
# Looks for the placeholder strings that have shipped accidentally
# before (the Sentry "YOUR_DSN_HERE", the GA "G-XXXXXXXXXX", the goals
# wallet credit shipped as commented-out pseudocode, etc.). Warning only
# — these aren't always bugs.
# ════════════════════════════════════════════════════════════════════════
section "5. Placeholder / stale-marker sweep"
PATTERNS='YOUR_DSN_HERE|G-XXXXXXXXXX|XXXXXXXXX|TODO_BEFORE_DEPLOY|FIXME_BEFORE_DEPLOY|HARDCODED'
hits=$(grep -rnE "$PATTERNS" --include="*.html" --include="*.js" --include="*.css" \
         "${HTML_FILES[@]}" "${JS_FILES[@]}" 2>/dev/null \
         | head -10)
if [[ -z "$hits" ]]; then
  pass "no obvious deploy placeholders"
else
  warn "${BOLD}placeholders found (intentional? confirm before push):${RESET}"
  echo "$hits" | sed "s|^|    ${DIM}|; s|\$|${RESET}|"
fi

# ════════════════════════════════════════════════════════════════════════
# §6. Core-protected file change warning
# ────────────────────────────────────────
# If any file listed in CORE_PROTECTED.md is in the git diff vs origin/main,
# print a loud reminder to run the full SMOKE_TEST.md before merging. Doesn't
# fail the build — Tier-1/Tier-2 files are legitimate to change, but they
# require extra verification because a regression there cascades across
# features. Empty repo or first-push has no origin/main yet; skip silently.
# ════════════════════════════════════════════════════════════════════════
section "6. Core-protected file change check"
# Hardcoded list of Tier-1 + Tier-2 patterns from CORE_PROTECTED.md.
# Keep in sync if CORE_PROTECTED.md changes.
CORE_PATTERNS=(
  'index.html'
  'admin.html'
  'js/app.js'
  'js/admin.js'
  'private/secrets.js'
  'scripts/pre-deploy-check.sh'
  'scripts/install-git-hook.sh'
  'supabase/migrations/'
  'css/styles.css'
  'css/admin.css'
  'js/event-log.js'
)
# Try to find a comparison base — origin/main, or fall back to last commit.
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  base="origin/main"
elif git rev-parse --verify main >/dev/null 2>&1; then
  base="main"
else
  base=""
fi
if [[ -z "$base" ]]; then
  warn "no origin/main or main branch found — skipping core-file check"
else
  # List files in the diff vs base; also include uncommitted staged + working
  # changes so the warning fires even on the first commit of a feature branch.
  changed=$(git diff --name-only "$base" 2>/dev/null; \
            git diff --name-only --cached 2>/dev/null; \
            git diff --name-only 2>/dev/null)
  changed=$(echo "$changed" | grep -v '^$' | sort -u)
  hits=""
  for f in $changed; do
    for pat in "${CORE_PATTERNS[@]}"; do
      if [[ "$f" == "$pat" ]] || [[ "$f" == *"$pat"* ]]; then
        hits="$hits$f\n"
        break
      fi
    done
  done
  if [[ -z "$hits" ]]; then
    pass "no core-protected files in this push"
  else
    warn "${BOLD}Core-protected file(s) in this push:${RESET}"
    printf "$hits" | sed "s|^|    ${DIM}|; s|\$|${RESET}|"
    warn "${BOLD}→ Run SMOKE_TEST.md before merging develop → main.${RESET}"
    warn "${DIM}  See CORE_PROTECTED.md for why these files need extra care.${RESET}"
  fi
fi

# ────────────────────────────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────────────────────────────
echo
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "${GREEN}${BOLD}━━━ All blocking checks passed (${WARN_COUNT} warning(s)) ━━━${RESET}"
  echo "${DIM}Safe to push. Warnings above are advisory — eyeball before deploy.${RESET}"
  exit 0
else
  echo "${RED}${BOLD}━━━ ${FAIL_COUNT} blocking failure(s), ${WARN_COUNT} warning(s) ━━━${RESET}"
  echo "${DIM}Push blocked. Fix the ✗ items above; re-run this script to verify.${RESET}"
  echo "${DIM}Bypass with \`git push --no-verify\` only if you know what you're doing.${RESET}"
  exit 1
fi
