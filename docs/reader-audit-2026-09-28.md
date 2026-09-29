# Reader audit — September 28, 2026

## Follow-up fixes

All eight confirmed issues below now have fixes in the working implementation.
Reading continuations check session identity, loading respects Pause, exports
check document identity and capture speed, premium recovery preserves explicit
preferences, all valid interrupted positions resume, and device errors stop the
reader cleanly. The regression harness now asserts these behaviors (including
subtitle invalidation and stale error callbacks) and fails on a regression.
The browser regression also verifies Pause while MP3 bytes are arriving.

The stalled-playback watchdog additionally stops with a saved position instead
of treating a stall as successful completion and skipping text. The remaining
code-review concerns about subtitle timing at changed speeds, delayed imports,
and origin validation are not part of these eight fixes.

## Scope and evidence

Reviewed the reader, export, file-loading, and API code. Exercised the production
site in a desktop Chromium browser, and ran the actual JavaScript functions in
an isolated Node VM with delayed network/audio adapters. The VM checks do not
contact production and are reproducible with:

```text
node scripts/audit_reader_lifecycle.js
```

The live browser was running release `7233441` (`readaloud.js?v=20260927b`). The
isolated checks used the pending voice-consistency fix. These are functional
playback and UI checks, not a subjective listening assessment or a physical
iPhone/Android screen-lock test.

## Live browser checks

| Voice / input | Observed result |
| --- | --- |
| Aria, 17 English words | Reached Finished, 100%, about eight seconds |
| Aria, 288 English words at 2x | Both sections completed; Finished at 100% in 58 seconds |
| Sonia, 492 English words | Loaded multiple sections; exercised Pause, Resume, speed change and Stop; later section failed on both servers |
| Guy, 87 English words | Played; Pause/Resume worked once loaded; after Stop, MP3 and subtitle actions reached their ready states |
| Dalia, 22 Spanish words | Reached Finished, 100%, about ten seconds |
| Device default, seven English words | Speech error `interrupted`; UI remained Playing at 100% for over a minute with Pause/Stop displayed |

Sonia's failing section logged a primary abort at 20:10:17 UTC followed by
backup-server synthesis timeouts at 20:10:38 and 20:11:00 UTC. This confirms that
production synthesis can still fail despite the earlier shorter timeout change;
it does not establish the upstream cause. The initiating browser-speech error
could depend on the host's speech support, but failing to exit the Playing state
after that error is directly visible in the error handler.

## Original confirmed findings (addressed by the follow-up)

### P1 — Old requests can affect a new reading

In `useTimedNeuralSpeech`, post-await checks use shared `isSpeaking` and `timed`
globals without identifying which reading owns the request. Start A, Stop, Start
B, and then resolve A: A's old passage is handed to playback while B is active.
Reject A instead and its error handler clears B's session. Reproduced both cases
in the VM. Use per-reading identity, guard continuations/error handlers against
that identity, and cancel abandoned work where practical.

### P1 — Pause during loading is ignored when audio arrives

The pause check occurs before the segment fetch. If Pause is pressed while the
fetch is pending, the code proceeds into `playTimedSegment` after the response
without checking Pause again. The isolated test recorded playback with
`isPaused === true`. Check pause state after asynchronous loading and at playback
entry, including seek and resume paths.

### P1 — Editing text does not cancel an in-progress export

The earlier stale-export fix disables buttons and clears `lastRead`, but an
already-running `downloadMp3` retains the previous segments. After an edit it
can still create/download the old document and re-enable its button in `finally`.
The VM reproduced an old MP3 downloading after invalidation. Subtitle export
has the same missing ownership checks across awaits. Snapshot the export's
document identity and discard its result/UI updates after invalidation.

### P2 — Progress and saved position can advance before any audio plays

`progressLoop` falls back to an elapsed-time estimate while a timed session is
waiting with no current audio. Ten seconds of waiting marked 150 unspoken
characters as read in the VM. The live UI also showed progress during Loading.
Stopping or failing then can save a position ahead of the spoken text. Keep
timed progress fixed while loading, paused, or stalled.

### P2 — MP3 speed can change halfway through the downloaded file

`downloadMp3` captures the chosen speed for its filename/cache key, but each
`fetchChunkWithRetry` reads the current slider again. Changing the slider during
preparation made requests use 0.8 then 1.5, while the file was named 0.8x. Snapshot
voice, text, and speed for the whole export and pass the speed explicitly.

### P2 — Automatic fallback can leave Default Voice selected after recovery

The health check removes premium options on failure. When service recovers,
`populateVoiceSel` preserves `browser:-1` because it cannot distinguish an
automatic fallback from an explicit user choice. The VM reproduced that retained
selection with premium availability restored. This can explain the original
default-voice complaint even after the initialization fix. Preserve explicit
preference separately from temporary service availability.

### P2 — Saved positions near the beginning/end are deliberately ignored

Resume currently requires a saved offset greater than 200 and below 90% of the
document. A saved position at character 100 was discarded in the VM. This is
especially misleading after the new outage message says the place was saved.
Distinguish completed readings from interrupted ones instead of using these
thresholds to infer completion.

### P2 — Browser speech errors leave the reader stuck in Playing

`utter.onerror` displays an error but never ends the session or releases the
controls. This was observed live with the seven-word default-voice test. Handle
expected cancellation separately; use bounded retries or stop with usable Start
controls on actual speech failure.

## Additional code concerns, not reproduced end to end

- The timed playback watchdog treats 45 seconds without progress as successful
  completion, which can skip unspoken text. It also excludes `audio.paused`, so
  an unexpected browser pause without a recovery event can remain stuck.
- Non-1x MP3s are synthesized anew, while subtitle timing is derived by scaling
  the original 1x synthesis. Exact alignment is not guaranteed; verify against
  the actual exported audio before promising word-for-word synchronization.
- A delayed file import can overwrite edits or a newly started reading because
  only the upload button is disabled while parsing. Add import ownership checks.
- `_origin_allowed` uses string-prefix matching; parse and compare origins
  exactly. CORS has an exact allowlist, so this is not evidence of a CORS bypass.

## Approved accent fix

The premium reader explicitly requests Edge, rejects a response identifying a
different engine, and tries the same voice through the second server. On failure
it stops and saves the position instead of switching to device speech. This audit
also closed the older-server compatibility route that could still substitute a
browser voice. The existing mocked browser regression passed for Sonia; the VM
confirmed that timed-endpoint 404s no longer enter the legacy player.

The issues above were not fixed by the accent change itself; they are addressed
in the later lifecycle fixes described at the top of this report.
