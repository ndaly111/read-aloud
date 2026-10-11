# Playback diagnostics

The reader sends small, allowlisted operational events to the primary TTS server.
This is independent of voice synthesis and never blocks Start, Pause, Resume or
Stop. Transport failures are ignored with no retries or browser persistence.
The browser sends at most 100 events per reading (60 ordinary samples plus room
for 40 failures/recovery/end events), plus one reserved feedback snapshot, deduplicates repeated events for five seconds, and
samples playback every 15 seconds while its diagnostic session is active.
Background throttling may delay samples; a missing heartbeat is not proof of a
playback failure. Diagnostic requests time out after five seconds on browsers
supporting AbortSignal.timeout. No backup server is woken just to upload logs.
Up to four failed reports are held in page memory and retried once on a subsequent
heartbeat, feedback submission, network recovery, or page exit. Retries preserve
their original reading IDs. Nothing is persisted to browser storage. If the primary
server is unreachable, a blocker blocks diagnostics, or the page/process closes
before transmission, events may be lost. This is not a guaranteed audit trail.

## Storage and access

`api/playback_diagnostics.py` installs the routes on the existing FastAPI app.
Storage defaults to `TTS_USAGE_DB` (the existing persistent SQLite database),
or can be separated by setting `TTS_DIAGNOSTICS_DB` to a writable SQLite path.
With neither variable set, collection returns 503 and nothing is stored.
Database initialization/write failures do not fail a voice request.

`diagnostic_events` contains `id`, server receipt time (`created_at`, Unix
seconds), `reading_id`, `event`, and structured JSON `payload`. Successful TTS
requests remain in the existing `tts_requests` table. New `tts_failure` events
include request path, HTTP status, elapsed generation time and bounded numeric
request/attempt IDs, including 429,
validation failures, upstream failures and timeouts. They deliberately omit
request bodies, exception messages, IPs and arbitrary HTTP header values. The client attaches
`X-Reading-ID` to synthesis requests so failures can be joined to playback.
This header is captured when a fetch starts; retries cannot inherit the next
reading's ID. Downloads after Stop have no playback ID.
`X-TTS-Request-ID` and `X-TTS-Attempt` correlate retries with client events within
one reading. These are bounded integers, not persistent device identifiers.

Rows are capped at 50,000 per server. Events older than 30 days are pruned on
the next write (at most once per minute) and never returned by the review API.
The row cap can shorten retention substantially below 30 days under traffic;
missing older records do not demonstrate that no failures occurred.
Error and feedback snapshots are additionally retained in `diagnostic_reports`,
with their own 5,000-row cap and the same 30-day expiry. Heartbeats cannot evict
these reports. Both tables are created automatically in the existing database.
Client diagnostics have a separate, bounded in-memory rate limit of 120
requests per minute per network address; this does not consume the TTS quota.
Addresses used for rate limiting are not saved in diagnostic records. Hosting
providers and the ordinary HTTP access log may still record network addresses.

The review route reuses `TTS_ADMIN_TOKEN`. It accepts the token only through the
`X-Admin-Token` header, avoiding secrets in URLs/access logs. It returns at most
500 records, newest first:

```text
GET /admin/playback-logs?limit=100
GET /admin/playback-logs?reading_id=<UUID>&limit=500
GET /admin/crash-reports?reading_id=<UUID>&limit=500
X-Admin-Token: <existing admin token>
```

For a local database query, without any token:

```sql
SELECT datetime(created_at, 'unixepoch') AS utc, reading_id, event, payload
FROM diagnostic_events
WHERE created_at BETWEEN unixepoch('2026-10-04 01:15:00')
                     AND unixepoch('2026-10-04 01:40:00')
ORDER BY id;
```

The feedback form includes the latest reading's ID; the relay validates it and
adds `Reading ID:` to the support email. There is no persistent user ID, cookie,
text hash, full user agent, raw error message, document text or audio in these
logs. Device voices are represented as `device`, without a potentially personal
voice label. The full payload schema rejects unknown fields.

Feedback emails also include the controls at the time of submission: language,
voice name and selection ID, Premium/Browser type, speed, and volume. These are
distinct from the logged reading's settings if the reader changed controls
afterwards. On iPhone/iPad the email says volume uses device buttons rather than
reporting the ineffective web slider as the actual device volume. The contact
form and older clients continue to work without any of these optional fields.

## Investigating a report

Use the reading ID in the feedback email, or filter by receipt time. Compare
`unexpected_pause`, `waiting`, `stalled`, `audio_error`, `play_rejected`,
`voice_error`, `speech_restart`, `fetch_error` and `tts_failure` with the preceding
samples. Visibility, media time, speech engine flags, volume/mute and paused
state distinguish a suspended page, a stuck speech engine, a paused audio
element and a failed synthesis request. Logs cannot prove the speaker produced
audible sound when the media clock continues advancing normally.

### Request-level details (October 2026)

`build` identifies the diagnostic script; `reader_build` separately identifies
the playback implementation. Older readers may omit the latter. Fetch failures
and recoveries include only allowlisted, bounded fields: `endpoint` (`primary`
or `render`), `request_id`, `attempt`, `request_start`, `request_chars`,
`request_ms`, `http_status`, `stage`, `audio_bytes`, `expected_chars`, and
`returned_chars`. No URLs or response bodies are stored. Request position is
separate from playback position because prefetch can fail ahead of the listener.
Retries are deduplicated by request/attempt identity, so fast retries remain
distinguishable. `fetch_recovered` records a successful retry or host change,
not every successfully fetched section. A late response from an old reading
cannot be attributed to a new reading.

Codes distinguish `timeout`, `network`, HTTP errors, `invalid-response`,
`invalid-audio`, `audio-too-small`, `incomplete-audio`, and `wrong-engine`.
`reading_error` retains the final request's classification and details. A 200
response followed by `incomplete-audio` is client validation failure, not an
HTTP outage. Character validation counts use the response's declared units:
new timed responses declare `text_units: utf16`; unmarked older responses use
Python code points. The reader normalizes word anchors to browser UTF-16 units.
These logs diagnose failures; they are not a complete Render bandwidth ledger.

### Error and feedback reports (October 11, 2026)

Snapshots include `phase`, `loop_on`, `loop_gap_sec`, `loop_gap_active`,
`loop_remaining_ms`, segment count, media readiness/network state, and selected
voice/language alongside the original reading's settings. Loop transitions,
voice/language/rate/volume changes, seeking, exports and connectivity changes
are recorded. The in-memory ring retains twelve recent non-heartbeat events,
including phase, speed and loop settings, even after normal event uploads cap out.

Player failures, failed exports after Stop/Finish, uncaught same-origin JavaScript
errors, own-script loading errors and unhandled rejections generate `report` objects.
Only allowlisted error class names and up to six own-asset basenames plus numeric
line/column locations survive stack sanitization. Never accept exception messages,
function names, raw stacks, URLs/query strings, document content or file names.
The server validates every nested field and caps the entire request at 8 KiB.
Unexpected TTS server exceptions and 5xx responses also create reports without
retaining exception messages. A signature derived from sanitized error identity,
code and reader build groups repeated failures without identifying a visitor.

Failures before Start receive a temporary page ID; stopped readings retain their
report ID without attaching it to new synthesis requests. Feedback sends a report
immediately before attaching that ID to the email, including after completion.
The send is independent of feedback delivery, so the email can arrive first.
If the primary remains unavailable, its report may be missing even when email succeeds.

A 90-second lack of observable progress during visible, unpaused loading/playback
generates `no_progress`. Pauses, deliberate loop countdowns and hidden tabs are
excluded. This observes symptoms and never changes playback or retries speech.
The reporting feature cannot catch a terminated browser process, OS crash or lost
power, cannot recover past unrecorded settings, and cannot prove audible sound.

To investigate: look up the feedback ID in `/admin/crash-reports`, examine its
snapshot and action ring, then cross-check `/admin/playback-logs` for request
attempts and recovery. Use `report.signature` to recognize recurring code failures.

## Shipping

Deploy the API before the new browser script. The existing persistent usage
database needs no extra environment configuration. Deploy the feedback worker
as well to include IDs in support emails. The static site loads the diagnostic
script before the reader with versioned URLs. Instrumentation adds no playback
behavior or homepage copy; the privacy page describes the collected fields.

Checks: `python api/selftest_diagnostics.py`,
`node scripts/test_playback_diagnostics.js`,
`node scripts/test_feedback_reading_id.js`,
`node scripts/test_tts_failover.js`,
`node scripts/test_speech_segments.js`,
`node scripts/audit_reader_lifecycle.js`.

The optional full-browser check is `node scripts/e2e_playback_diagnostics.js`
(Playwright and Edge required); service requests are intercepted locally.
The Python diagnostic self-test uses FastAPI's TestClient and requires httpx.
