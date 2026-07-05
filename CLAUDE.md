# read-aloud.com — Project Instructions

Static site (GitHub Pages, Jekyll workflow) + FastAPI TTS server (`api/`) running on
the mini PC behind a Cloudflare tunnel at `https://tts.read-aloud.com`.

## Deploy facts

- Push to `main` → GitHub Pages builds and deploys the site automatically.
- The API server updates via the `tts-update` screen session (5-min git poll), or
  manually: `wsl -d Ubuntu -u ubuntu bash -c "bash /home/ubuntu/read-aloud-update.sh"`.
- `readaloud.js` and `styles.css` are loaded with `?v=` cache-bust params in
  `index.html` — bump them when those files change. `index.html` itself needs no bump.
- NEVER poll a new production `?v=` URL before the Pages build completes — Cloudflare
  edge-caches the old content under the new query string for hours. Verify with a
  throwaway param first.
- `.gitignore` blocks `*.py` and `*.json` everywhere — new Python/JSON files need
  `git add -f`.

## Latest updates workflow (REQUIRED before pushing user-visible changes)

The homepage has a "Latest updates" section (`<ul class="updates-list">` in
`index.html`). Every user-visible improvement MUST ship with an entry there.
A warn-only `pre-push` hook (see below) will flag pushes that forget.

Process, before the final push of a work session:

1. Find the newest date in the updates list, then run `git log` since that date so
   the entries reflect what actually shipped — not memory.
2. Draft one entry per user-visible improvement. **Show the draft wording to Nick
   and wait for his approval before inserting it.** Never publish homepage copy
   he hasn't seen.
3. Prepend approved entries to the TOP of `<ul class="updates-list">` (newest
   first), matching the existing format exactly:

   ```html
   <li>
     <span class="upd-date">Jul 5, 2026</span>
     <span class="upd-text">Plain-language description of what got better.</span>
   </li>
   ```

Writing rules for entries:

- Describe what got better **from the user's point of view** — what they can now
  do, or what stopped being annoying. No developer jargon (no "refactored",
  "endpoint", "cache", "regression").
- If the fix came from reader feedback, say thanks: "(Thanks to the reader who
  wrote in about this.)"
- Keep each entry to one or two sentences.

What counts as user-visible: anything a visitor could notice — behavior, appearance,
speed, reliability of the player, new features. What doesn't: internal refactors,
server config, docs, tests, this file. If the pre-push hook warns but the change is
genuinely invisible, say so in the session and push anyway (the hook never blocks).

## Pre-push hook setup (one-time per clone)

The safety-net hook lives in `hooks/pre-push` (versioned). Activate it with:

```
git config core.hooksPath hooks
```
