# Premium speech outage, October 12, 2026

Both production servers returned HTTP 500 for an uncached timed request with
`engine: edge`. The underlying Microsoft WebSocket handshake returned HTTP 403
from the legacy `speech.platform.bing.com` synthesis host. Health checks on both
servers still returned HTTP 200. The primary already had edge-tts 7.2.8, the
latest published release; an ordinary dependency update would not fix this.

The upstream incident is https://github.com/rany2/edge-tts/issues/490.
The proposed transport fix is https://github.com/rany2/edge-tts/pull/491.

The API now redirects the library's legacy synthesis URL to Microsoft's
`api.msedgeservices.com/tts/cognitiveservices/websocket/v1` host, using the same
client token as `Ocp-Apim-Subscription-Key`. This preserves the existing
authentication algorithm, voice IDs, MP3 format and word-boundary protocol.
Only the exact legacy URL prefix is replaced; a future library release using
a different transport retains its own URL. Both timed playback and MP3 export
use this configuration. The browser needs no changes or refresh to receive
restored synthesis after the server restarts.

Validation before deployment:

- Direct synthesis produced audio and word events for Aria, Sonia, Guy and HoaiMy.
- Real FastAPI requests produced Edge audio, complete UTF-16 character counts,
  valid anchors and duration for twelve voices covering all ten supported languages.
- MP3 requests succeeded at +0%, -50%, and +100% rates.
- The timed self-test including live word alignment, diagnostic server self-test,
  client failover/Unicode validation checks, and `git diff --check` passed.

This resolves the observed handshake failure. The replacement host remains an
external service; future upstream changes may require another library update.
