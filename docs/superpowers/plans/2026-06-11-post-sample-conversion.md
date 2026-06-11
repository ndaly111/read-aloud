# Post-Sample Conversion Moments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the moment right after a visitor finishes hearing a Studio voice sample — show a plans CTA at peak desire, let the plans modal play the sample, fix the nudge copy that insults the free voices, and measure all of it in the admin funnel.

**Architecture:** Pure frontend (static HTML/CSS/JS on GitHub Pages) plus a 4-line backend touch (FastAPI `api/billing.py`) to whitelist + display one new funnel event. Frontend deploys on push to `main` (Pages build ~1-2 min). Backend auto-deploys to the mini PC via the `tts-update` screen (git pull every 5 min, restarts `tts-api`). Everything reuses existing functions: `playSample()`, `togglePreview()`, `showStudioNudge()`, `trackEvent()`, the `#studioNudge` element, and `.nudge-btn` CSS.

**Tech Stack:** Vanilla JS (no framework, no build step), CSS custom properties (`--vermilion`, `--paper`), FastAPI + SQLite (`events` table, daily rollup).

**Testing reality:** This repo has no test framework (static site). Verification per task = `node --check readaloud.js` (syntax), `python -c "import ast; ast.parse(open('api/billing.py').read())"` (syntax), grep assertions that the change landed, and a final live check after deploy. Do NOT introduce a test framework for this.

**Explicitly out of scope:** the bounded 150-char personalized trial (item 4 — awaiting Nick's yes/no), any pricing/tier changes, any change that costs ElevenLabs characters (`playSample` serves a cached clip; nothing here calls personalized synthesis).

---

## File Map

| File | Change |
|---|---|
| `api/billing.py` | Add `sample_done` to `_ALLOWED_EVENTS` (line ~910), to `events_summary` list (line ~1121), and a funnel table row (line ~1158) |
| `readaloud.js` | Rewrite `showStudioNudge()` (~line 1200) with 3 modes; add `onended` hook in `playSample()` (~line 1180); bind `#modalSampleBtn` (~line 146) |
| `index.html` | Add `▶ Hear the voice` button inside the upgrade modal (after `.modal-lede`, ~line 278); bump cache-bust `v=20260609a` → `v=20260611a` (2 refs) |
| `styles.css` | Add `.modal-sample-btn` styles (before the `@media (max-width: 640px)` block) |

All paths relative to repo root `C:\Users\ndaly\projects\read-aloud`.

---

### Task 1: Backend — whitelist and display the `sample_done` funnel event

**Why first:** the backend auto-deploys on a 5-min poll, so landing it first means the API already accepts the event by the time the frontend ships. Unknown event names are silently dropped (allowlist), so there is zero breakage risk in either deploy order — this is just nicer sequencing.

**Files:**
- Modify: `api/billing.py:910` (allowlist)
- Modify: `api/billing.py:1121` (events_summary list)
- Modify: `api/billing.py:1158` (funnel table row)

- [ ] **Step 1: Add to allowlist**

Find (line ~910):
```python
_ALLOWED_EVENTS = {"upgrade_open", "studio_select", "checkout_click"}
```
Replace with:
```python
_ALLOWED_EVENTS = {"upgrade_open", "studio_select", "checkout_click", "sample_done"}
```

- [ ] **Step 2: Add to the summary query list**

Find (line ~1121):
```python
        out["events"] = events_summary(
            ["sample_play", "studio_select", "upgrade_open", "trial_play", "checkout_click"])
```
Replace with:
```python
        out["events"] = events_summary(
            ["sample_play", "sample_done", "studio_select", "upgrade_open",
             "trial_play", "checkout_click"])
```

- [ ] **Step 3: Add the dashboard row**

Find (line ~1156):
```python
    parts.append(evrow("Voice samples played", "sample_play"))
```
Add immediately after it:
```python
    parts.append(evrow("Samples heard to the end", "sample_done"))
```

- [ ] **Step 4: Verify syntax**

Run: `python -c "import ast; ast.parse(open('api/billing.py').read())" && echo PY_OK`
Expected: `PY_OK`

Run: `grep -c "sample_done" api/billing.py`
Expected: `3`

- [ ] **Step 5: Commit**

```bash
git add api/billing.py
git commit -m "Track sample_done: completed Studio sample listens in the funnel"
```

---

### Task 2: Rewrite `showStudioNudge()` — three modes + copy fix

This one function change delivers two of the three review items: the after-sample CTA UI (item 1) and the copy fix (item 3). The third mode (`'after-sample'`) flips button prominence so **See plans** becomes the primary action at the hot moment.

**Files:**
- Modify: `readaloud.js:1200-1215` (the whole `showStudioNudge` function)

- [ ] **Step 1: Replace the function**

Find (lines ~1200-1215):
```js
function showStudioNudge(mode) {
  const el = $('studioNudge');
  if (!el) return;
  const eligible = studioVoices.length && !(license && license.status === 'active');
  if (!eligible) { el.hidden = true; return; }
  const intro = mode === 'sample'
    ? "<strong>That's a Studio voice — here's a free sample.</strong> The free voices above play "
      + 'your full text instantly. Studio is an optional upgrade for the most lifelike narration.'
    : 'That was a computer voice. Studio voices sound far more natural.';
  el.innerHTML = intro + ' '
    + '<button type="button" class="nudge-btn" id="nudgeSample">▶ Hear free sample</button> '
    + '<button type="button" class="nudge-btn nudge-btn--ghost" id="nudgePlans">See plans</button>';
  el.hidden = false;
  const s = $('nudgeSample'); if (s) s.onclick = playSample;
  const p = $('nudgePlans'); if (p) p.onclick = openUpgrade;
}
```

Replace with:
```js
function showStudioNudge(mode) {
  const el = $('studioNudge');
  if (!el) return;
  const eligible = studioVoices.length && !(license && license.status === 'active');
  if (!eligible) { el.hidden = true; return; }
  // Three moments, one element (copy reviewed: no emojis, no brochure-speak,
  //   at most one "free" per message):
  //   'sample'       — visitor pressed Play on a Studio voice (sample now playing)
  //   'after-sample' — the sample just FINISHED: peak desire, plans become primary
  //   (default)      — a free playback ended; quiet invitation, shows often
  let intro, sampleLabel = 'Hear a sample';
  let plansPrimary = false;
  if (mode === 'sample') {
    intro = "<strong>That's a Studio voice, so here's a sample of it.</strong> "
      + 'The free voices above will read your full text right now.';
  } else if (mode === 'after-sample') {
    intro = "<strong>Like that voice?</strong> That's Studio. $9 a month, "
      + 'and the rest of the tool stays free.';
    sampleLabel = 'Play it again';
    plansPrimary = true;
  } else {
    intro = 'The Studio voices sound like an actual person reading.';
    sampleLabel = 'Hear one';
  }
  el.innerHTML = intro + ' '
    + '<button type="button" class="nudge-btn' + (plansPrimary ? ' nudge-btn--ghost' : '')
    + '" id="nudgeSample">' + sampleLabel + '</button> '
    + '<button type="button" class="nudge-btn' + (plansPrimary ? '' : ' nudge-btn--ghost')
    + '" id="nudgePlans">See plans</button>';
  el.hidden = false;
  const s = $('nudgeSample'); if (s) s.onclick = playSample;
  const p = $('nudgePlans'); if (p) p.onclick = openUpgrade;
}
```

- [ ] **Step 2: Verify**

Run: `node --check readaloud.js && echo JS_OK`
Expected: `JS_OK`

Run: `grep -c "after-sample" readaloud.js`
Expected: `2` (will become 3 after Task 3)

Run: `grep -c "That was a computer voice" readaloud.js`
Expected: `0`

- [ ] **Step 3: Commit**

```bash
git add readaloud.js
git commit -m "Nudge: add after-sample mode, stop insulting the free voices"
```

---

### Task 3: Fire the moment — sample `onended` → CTA + tracking

**Files:**
- Modify: `readaloud.js:1180-1184` (the `previewAudio.onended` handler inside `playSample()`)

- [ ] **Step 1: Replace the onended handler**

Find (inside `playSample()`, lines ~1180-1184):
```js
    previewAudio.onended = () => {
      URL.revokeObjectURL(url);
      previewAudio = null;
      if (btn) btn.textContent = 'Hear a sample';
    };
```

Replace with:
```js
    previewAudio.onended = () => {
      URL.revokeObjectURL(url);
      previewAudio = null;
      if (btn) btn.textContent = 'Hear a sample';
      // The sample just finished — the hottest moment in the funnel.
      trackEvent('sample_done');
      // Inline CTA only when the plans modal isn't already showing the offer.
      const modal = $('upgradeModal');
      if (modal && modal.hidden) showStudioNudge('after-sample');
    };
```

Notes for the implementer:
- `trackEvent` already exists in this file (see `trackEvent('checkout_click')` at ~line 1273) and POSTs fire-and-forget; no error handling needed here.
- The modal guard matters because Task 4 adds an in-modal sample button — when the sample is played *from* the modal, the page-level nudge underneath would be invisible and would clutter state.
- Do NOT touch `previewAudio.onerror` — a failed sample is not a conversion moment.

- [ ] **Step 2: Verify**

Run: `node --check readaloud.js && echo JS_OK`
Expected: `JS_OK`

Run: `grep -n "sample_done" readaloud.js`
Expected: exactly 1 match, inside the `onended` handler.

- [ ] **Step 3: Commit**

```bash
git add readaloud.js
git commit -m "Show plans CTA + track sample_done when a Studio sample finishes"
```

---

### Task 4: In-modal "Hear the voice" button

**Files:**
- Modify: `index.html:276-278` (after `.modal-lede` inside `#upgradeModal`)
- Modify: `readaloud.js:146` (binding, next to the existing `upgradeBtn` binding)
- Modify: `styles.css` (new `.modal-sample-btn` block, insert directly before the `@media (max-width: 640px)` block)

- [ ] **Step 1: Add the button to the modal markup**

Find in `index.html` (lines ~276-278):
```html
    <p class="modal-lede">
      Studio voices are close enough to a real narrator that you stop noticing it's a machine.
    </p>
```
Replace with:
```html
    <p class="modal-lede">
      Studio voices are close enough to a real narrator that you stop noticing it's a machine.
    </p>
    <button type="button" id="modalSampleBtn" class="modal-sample-btn">Play a sample</button>
```

- [ ] **Step 2: Bind it in JS**

Find in `readaloud.js` (line ~146):
```js
  if (upBtn) upBtn.onclick = openUpgrade;
```
Add immediately after:
```js
  const modalSampleBtn = $('modalSampleBtn');
  if (modalSampleBtn) modalSampleBtn.onclick = togglePreview;
```

`togglePreview` (defined ~line 1149) already handles play/stop toggling and falls back to a pleasant default voice (`defaultPreviewVoiceId()`, prefers Sarah) when the dropdown selection isn't a Studio voice. The sample is the cached clip — $0 per play.

- [ ] **Step 3: Style it**

In `styles.css`, insert directly BEFORE the `@media (max-width: 640px)` block:
```css
/* —— in-modal sample button: the buy screen should make sound —— */
.modal-sample-btn {
  display: inline-flex;
  align-items: center;
  gap: .45rem;
  margin: 0 0 1.15rem;
  padding: .5rem 1.05rem;
  font-family: var(--font-mono);
  font-size: .78rem;
  letter-spacing: .05em;
  background: transparent;
  border: 1.5px solid var(--vermilion);
  color: var(--vermilion);
  border-radius: 999px;
  cursor: pointer;
}
.modal-sample-btn:hover {
  background: var(--vermilion);
  color: var(--paper-bright);
}
```

- [ ] **Step 4: Verify**

Run: `node --check readaloud.js && echo JS_OK`
Expected: `JS_OK`

Run: `grep -c "modalSampleBtn" index.html readaloud.js`
Expected: `index.html:1` and `readaloud.js:2`

Run: `grep -c "modal-sample-btn" styles.css`
Expected: `3` (comment line + two selectors) — at minimum `2`.

- [ ] **Step 5: Commit**

```bash
git add index.html readaloud.js styles.css
git commit -m "Plans modal: add free in-modal Studio sample playback"
```

---

### Task 5: Cache-bust, deploy, live verify

**Files:**
- Modify: `index.html` (2 cache-bust refs: `styles.css?v=` and `readaloud.js?v=`)

- [ ] **Step 1: Bump cache-bust version**

In `index.html`, change BOTH occurrences of `v=20260609a` → `v=20260611a`:
```html
  <link rel="stylesheet" href="/styles.css?v=20260611a">
```
and (near the bottom of the file):
```html
<script src="/readaloud.js?v=20260611a"></script>
```

Run: `grep -c "v=20260611a" index.html`
Expected: `2`

Run: `grep -c "v=20260609a" index.html`
Expected: `0`

- [ ] **Step 2: Commit and push (deploy)**

```bash
git add index.html
git commit -m "Cache-bust for post-sample conversion changes"
git push origin main
```

Push to `main` IS the deploy: GitHub Pages rebuilds the site (~1-2 min) and the mini PC's `tts-update` screen pulls + restarts `tts-api` within 5 min (Task 1's backend change goes live then).

- [ ] **Step 3: Live verify — frontend**

Wait ~2 minutes after push, then:

Run: `curl -s "https://read-aloud.com/readaloud.js?v=20260611a" | grep -c "after-sample"`
Expected: `3`

Run: `curl -s "https://read-aloud.com/" | grep -c "modalSampleBtn"`
Expected: `1`

- [ ] **Step 4: Live verify — backend (after the 5-min auto-pull window)**

Run (from Windows; WSL hosts the API):
`wsl -- bash -lc "grep -c sample_done /home/ubuntu/read-aloud/api/billing.py"`
Expected: `3` (confirms the pull landed; `tts-update` restarts the API itself)

Run: `wsl -- bash -lc "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/"`
Expected: `200`

- [ ] **Step 5: Confirm the funnel row appears**

Within a day, `sample_done` should show on the admin dashboard ("Samples heard to the end") and its ratio to `sample_play` tells us how many visitors listen all the way through — the population the new CTA targets.

---

## Self-Review (done at write time)

- **Coverage:** item 1 (post-sample CTA) = Tasks 2+3; item 2 (in-modal sample) = Task 4; item 3 (copy fix) = Task 2; measurement = Tasks 1+3. Item 4 (bounded trial) intentionally excluded — pending Nick's decision.
- **Type/name consistency:** `showStudioNudge('after-sample')` (Task 3) matches the mode string in Task 2. `togglePreview`/`playSample`/`trackEvent`/`defaultPreviewVoiceId` all pre-exist at the cited lines. `--vermilion`/`--paper-bright`/`--font-mono` confirmed in `styles.css:12-26`. `.nudge-btn`/`.nudge-btn--ghost` confirmed at `styles.css:1659/1943`.
- **Order safety:** unknown event names are dropped by the allowlist, so even if the frontend deploys before the backend pull, nothing errors — `sample_done` just isn't counted for those ~5 minutes.
