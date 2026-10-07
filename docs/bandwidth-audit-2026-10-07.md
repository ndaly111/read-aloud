# Read-Aloud bandwidth and speech timeout investigation

## Findings

The production reader prefers the mini PC at `tts.read-aloud.com`, with Render
as its second endpoint. Both health checks returned HTTP 200 during this review.
The primary served approximately 25,000–36,000 successful speech requests per
complete day from October 1 through October 6. Its speech process and tunnel
were running, with ample available memory.

The retained diagnostic window covered roughly ten hours on October 7 and
contained 523 HTTP 504 speech failures. The diagnostic table is capped at
50,000 rows, so this is a recent sample, not the full month's failure count.
Successful Sonia requests averaged about 12 seconds that morning, compared
with about 3–4 seconds for Aria and Guy. Generation is limited to 20 seconds.

Direct synthetic-text probes reproduced a healthy stream being interrupted
by the deadline. All eight Aria/Guy samples finished in 2.3–5.9 seconds. Of
eight long Sonia/HoaiMy samples, five exceeded even a 25-second probe limit;
audio began within about 1–2 seconds and continued arriving until the cutoff.
One successful HoaiMy sample took 22.7 seconds, which also exceeds the API's
20-second limit. This establishes that some failures are caused by the size
of sections sent to voices that generate audio more slowly.

These failures can trigger the reader's Render fallback. The backup remains
preferred for five minutes after the primary fails. Render's exact October
bandwidth and this service's share of the workspace total could not be read:
the connected browser repeatedly timed out opening its dashboard.

## Change

Use a 400-character section limit for Sonia and HoaiMy. Keep the 1,200-character
limit for other voices. The existing splitter retains original character
positions, and MP3/subtitle exports use the same playback sections. This
preserves the selected voice and the existing server/request timeout limits.

Smaller sections add requests for the affected voices, while keeping the same
text and audio content. This trades a modest increase in request overhead for
fewer attempts that discard partially generated audio and switch to Render.
It does not address every possible upstream or network failure.

## Validation

Twelve unique shorter-text probes across Sonia and HoaiMy completed without
timeouts, including MP3 generation at half speed. Their slowest completion was
9.6 seconds. A preceding repeated-text test also passed, but the unique-text
results are used here to avoid relying on upstream caching.

Local checks passed:

- `node --check readaloud.js`
- `node scripts/test_speech_segments.js`: voice limits, complete text coverage,
  absolute positions, shared playback/export sections, and restart caching.
- `node scripts/audit_reader_lifecycle.js`: all existing lifecycle checks.
- `node scripts/test_playback_diagnostics.js`
- `node scripts/test_feedback_reading_id.js`
- `python api/selftest_timed.py`: word-position mapping checks.
- `git diff --check`

After publication, confirm the Pages deployment completed before requesting
the new versioned script URL. Review new primary failures and Render's
service bandwidth after readers have loaded the updated page. Historical
charges and already-open sessions will not be changed by this release.
