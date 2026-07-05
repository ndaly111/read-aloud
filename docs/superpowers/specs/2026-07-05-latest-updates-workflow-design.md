# Latest Updates Workflow — Design

**Date:** 2026-07-05
**Status:** Approved by Nick (Option B: instructions + safety-net hook)

## Goal

Every user-visible improvement shipped to read-aloud.com gets a dated, plain-language
entry in the homepage "Latest updates" list — reliably, not just when someone remembers.
Nick approves the wording of every entry before it goes public.

## Components

### 1. `CLAUDE.md` (repo root)

Project instructions loaded by every Claude Code session in this repo. The
"Latest updates workflow" section instructs:

- Before the final push of any user-visible improvement: find the newest date in the
  updates list, run `git log` since that date so entries reflect real commits, and
  draft one plain-language entry per improvement.
- Show the draft wording to Nick and wait for approval before inserting it.
- Prepend the approved entry to `<ul class="updates-list">` in `index.html`
  (newest first) using the existing format:
  `<li><span class="upd-date">Jul 5, 2026</span><span class="upd-text">…</span></li>`
- Writing rules: describe what got better from the user's point of view; no developer
  jargon; credit reader feedback when a fix came from a report.
- Also records deploy facts (Pages auto-deploys on push; JS/CSS need cache-bust bumps,
  `index.html` does not) and the hook activation step for fresh clones.

### 2. `hooks/pre-push` (versioned safety net)

Shell script activated via `git config core.hooksPath hooks` (one-time per clone,
documented in CLAUDE.md). For each ref being pushed:

- No user-facing files changed (`index.html`, `readaloud.js`, `styles.css`, `api/`)
  → silent.
- User-facing files changed AND the diff touches the updates-list block
  (`upd-date` / `updates-list` appears in the `index.html` diff) → silent.
- User-facing files changed and the updates list did NOT → print a loud warning
  telling the pusher to draft an entry or state why the change is invisible.
- Always exits 0 (warn-only, never blocks). New-branch pushes (no remote sha) are
  skipped for simplicity — this repo pushes `main`.

## Verification

Run the hook directly with fabricated stdin for the three cases above, then confirm
a real push behaves correctly (the commit introducing this feature is itself
non-user-facing, so the hook should stay silent).

## Out of scope

- Other sites (RaeFitt, stockfinances) — generalize later if this proves useful.
- Automatic publishing without Nick's approval.
- A `/log-update` batch command (can be added later if catch-up ever needed).
