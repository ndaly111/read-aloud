#!/usr/bin/env python3
"""
Edge TTS API Server - Provides high-quality neural voices for Read-Aloud.

This server uses Microsoft Edge's free TTS API to generate natural-sounding
speech. Deploy on Render, Railway, or any Python hosting platform.

Usage:
    POST /api/tts
    {
        "text": "Hello world",
        "voice": "en-US-AriaNeural",
        "rate": "+0%",
        "pitch": "+0Hz"
    }

Returns: audio/mpeg stream
"""

import asyncio
import hashlib
import io
import os
import sqlite3
import time
from collections import OrderedDict
from datetime import datetime, timezone
from threading import Lock
from typing import Optional

import edge_tts
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# ----------------------------------------------------------------------
# Optional local usage telemetry
# Activated only when TTS_USAGE_DB env var points at a writeable SQLite path.
# Used on the mini PC; left unset on Render fallback so its ephemeral disk
# stays clean. No PII captured (no IPs, no text content, no user identifiers).
# ----------------------------------------------------------------------
USAGE_DB_PATH = os.environ.get("TTS_USAGE_DB")
_usage_lock = Lock()

if USAGE_DB_PATH:
    try:
        _conn = sqlite3.connect(USAGE_DB_PATH, timeout=5)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute(
            "CREATE TABLE IF NOT EXISTS tts_requests ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "ts TEXT NOT NULL, "
            "voice TEXT NOT NULL, "
            "char_count INTEGER NOT NULL, "
            "cache_hit INTEGER NOT NULL, "
            "duration_ms INTEGER NOT NULL)"
        )
        _conn.execute("CREATE INDEX IF NOT EXISTS idx_tts_requests_ts ON tts_requests(ts)")
        _conn.commit()
        _conn.close()
    except Exception as _e:
        # if init fails, telemetry simply stays disabled — don't block startup
        print(f"[tts] usage telemetry disabled — init error: {_e}")
        USAGE_DB_PATH = None


def _usage_log(voice: str, char_count: int, cache_hit: bool, duration_ms: int) -> None:
    if not USAGE_DB_PATH:
        return
    try:
        with _usage_lock:
            conn = sqlite3.connect(USAGE_DB_PATH, timeout=2)
            conn.execute("PRAGMA busy_timeout=2000")
            conn.execute(
                "INSERT INTO tts_requests (ts, voice, char_count, cache_hit, duration_ms) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    voice,
                    char_count,
                    int(bool(cache_hit)),
                    int(duration_ms),
                ),
            )
            conn.commit()
            conn.close()
    except Exception as e:
        # never let telemetry failure surface to the user
        print(f"[tts] usage_log error: {e}")

app = FastAPI(
    title="Read-Aloud TTS API",
    description="High-quality text-to-speech using neural voices",
    version="1.0.0"
)

# CORS - allow your domain
ALLOWED_ORIGINS = [
    "https://read-aloud.com",
    "https://www.read-aloud.com",
    "https://ndaly111.github.io",  # GitHub Pages
    "http://localhost:4000",  # Jekyll dev server
    "http://127.0.0.1:4000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

ALLOWED_ORIGIN_PREFIXES = tuple(ALLOWED_ORIGINS)


def _origin_allowed(request: Request) -> bool:
    """Allow only browser callers from a known site (Origin or Referer)."""
    origin = request.headers.get("origin", "")
    referer = request.headers.get("referer", "")
    if origin and origin.startswith(ALLOWED_ORIGIN_PREFIXES):
        return True
    if referer and referer.startswith(ALLOWED_ORIGIN_PREFIXES):
        return True
    return False


def _client_ip(request: Request) -> str:
    """Real client IP behind Render's proxy: first hop in X-Forwarded-For."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Rate limiting (simple in-memory, use Redis in production)
from collections import defaultdict
from datetime import datetime, timedelta

request_counts = defaultdict(list)
RATE_LIMIT = 50  # requests per minute
RATE_WINDOW = 60  # seconds
_sweep_counter = 0
SWEEP_EVERY = 1000


def check_rate_limit(ip: str) -> bool:
    """Simple rate limiting by IP, with amortized sweep of stale buckets."""
    global _sweep_counter
    now = datetime.now()
    cutoff = now - timedelta(seconds=RATE_WINDOW)

    _sweep_counter += 1
    if _sweep_counter >= SWEEP_EVERY:
        _sweep_counter = 0
        for k in list(request_counts.keys()):
            request_counts[k] = [t for t in request_counts[k] if t > cutoff]
            if not request_counts[k]:
                del request_counts[k]

    request_counts[ip] = [t for t in request_counts[ip] if t > cutoff]

    if len(request_counts[ip]) >= RATE_LIMIT:
        return False

    request_counts[ip].append(now)
    return True


class _AudioCache:
    """Thread-safe LRU bytes cache, capped by entry count and total size."""

    def __init__(self, max_entries: int = 100, max_bytes: int = 64 * 1024 * 1024):
        self._d: "OrderedDict[str, bytes]" = OrderedDict()
        self._size = 0
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._lock = Lock()

    def get(self, key: str) -> Optional[bytes]:
        with self._lock:
            if key in self._d:
                self._d.move_to_end(key)
                return self._d[key]
            return None

    def put(self, key: str, value: bytes) -> None:
        with self._lock:
            if key in self._d:
                self._size -= len(self._d[key])
                del self._d[key]
            self._d[key] = value
            self._size += len(value)
            while (len(self._d) > self._max_entries
                   or self._size > self._max_bytes) and self._d:
                _, evicted = self._d.popitem(last=False)
                self._size -= len(evicted)


audio_cache = _AudioCache()


# Available voices (curated list of best neural voices)
VOICES = {
    # English - US
    "en-US-AriaNeural": {"name": "Aria", "gender": "Female", "locale": "en-US", "style": "friendly"},
    "en-US-GuyNeural": {"name": "Guy", "gender": "Male", "locale": "en-US", "style": "newscast"},
    "en-US-JennyNeural": {"name": "Jenny", "gender": "Female", "locale": "en-US", "style": "assistant"},
    "en-US-DavisNeural": {"name": "Davis", "gender": "Male", "locale": "en-US", "style": "calm"},
    "en-US-AmberNeural": {"name": "Amber", "gender": "Female", "locale": "en-US", "style": "warm"},
    "en-US-AnaNeural": {"name": "Ana", "gender": "Female", "locale": "en-US", "style": "child"},
    "en-US-BrandonNeural": {"name": "Brandon", "gender": "Male", "locale": "en-US", "style": "conversational"},
    "en-US-ChristopherNeural": {"name": "Christopher", "gender": "Male", "locale": "en-US", "style": "reliable"},
    "en-US-CoraNeural": {"name": "Cora", "gender": "Female", "locale": "en-US", "style": "positive"},
    "en-US-ElizabethNeural": {"name": "Elizabeth", "gender": "Female", "locale": "en-US", "style": "elegant"},
    "en-US-EricNeural": {"name": "Eric", "gender": "Male", "locale": "en-US", "style": "rational"},
    "en-US-JacobNeural": {"name": "Jacob", "gender": "Male", "locale": "en-US", "style": "casual"},
    "en-US-MichelleNeural": {"name": "Michelle", "gender": "Female", "locale": "en-US", "style": "friendly"},
    "en-US-MonicaNeural": {"name": "Monica", "gender": "Female", "locale": "en-US", "style": "professional"},
    "en-US-SaraNeural": {"name": "Sara", "gender": "Female", "locale": "en-US", "style": "cheerful"},

    # English - UK
    "en-GB-SoniaNeural": {"name": "Sonia", "gender": "Female", "locale": "en-GB", "style": "professional"},
    "en-GB-RyanNeural": {"name": "Ryan", "gender": "Male", "locale": "en-GB", "style": "cheerful"},
    "en-GB-LibbyNeural": {"name": "Libby", "gender": "Female", "locale": "en-GB", "style": "warm"},
    "en-GB-ThomasNeural": {"name": "Thomas", "gender": "Male", "locale": "en-GB", "style": "calm"},

    # English - Australia
    "en-AU-NatashaNeural": {"name": "Natasha", "gender": "Female", "locale": "en-AU", "style": "friendly"},
    "en-AU-WilliamNeural": {"name": "William", "gender": "Male", "locale": "en-AU", "style": "conversational"},

    # Spanish
    "es-ES-ElviraNeural": {"name": "Elvira", "gender": "Female", "locale": "es-ES", "style": "standard"},
    "es-ES-AlvaroNeural": {"name": "Alvaro", "gender": "Male", "locale": "es-ES", "style": "standard"},
    "es-MX-DaliaNeural": {"name": "Dalia", "gender": "Female", "locale": "es-MX", "style": "standard"},
    "es-MX-JorgeNeural": {"name": "Jorge", "gender": "Male", "locale": "es-MX", "style": "standard"},

    # French
    "fr-FR-DeniseNeural": {"name": "Denise", "gender": "Female", "locale": "fr-FR", "style": "standard"},
    "fr-FR-HenriNeural": {"name": "Henri", "gender": "Male", "locale": "fr-FR", "style": "standard"},

    # German
    "de-DE-KatjaNeural": {"name": "Katja", "gender": "Female", "locale": "de-DE", "style": "standard"},
    "de-DE-ConradNeural": {"name": "Conrad", "gender": "Male", "locale": "de-DE", "style": "standard"},

    # Italian
    "it-IT-ElsaNeural": {"name": "Elsa", "gender": "Female", "locale": "it-IT", "style": "standard"},
    "it-IT-DiegoNeural": {"name": "Diego", "gender": "Male", "locale": "it-IT", "style": "standard"},

    # Portuguese
    "pt-BR-FranciscaNeural": {"name": "Francisca", "gender": "Female", "locale": "pt-BR", "style": "standard"},
    "pt-BR-AntonioNeural": {"name": "Antonio", "gender": "Male", "locale": "pt-BR", "style": "standard"},

    # Chinese
    "zh-CN-XiaoxiaoNeural": {"name": "Xiaoxiao", "gender": "Female", "locale": "zh-CN", "style": "standard"},
    "zh-CN-YunxiNeural": {"name": "Yunxi", "gender": "Male", "locale": "zh-CN", "style": "standard"},

    # Japanese
    "ja-JP-NanamiNeural": {"name": "Nanami", "gender": "Female", "locale": "ja-JP", "style": "standard"},
    "ja-JP-KeitaNeural": {"name": "Keita", "gender": "Male", "locale": "ja-JP", "style": "standard"},

    # Korean
    "ko-KR-SunHiNeural": {"name": "SunHi", "gender": "Female", "locale": "ko-KR", "style": "standard"},
    "ko-KR-InJoonNeural": {"name": "InJoon", "gender": "Male", "locale": "ko-KR", "style": "standard"},
}


class TTSRequest(BaseModel):
    """TTS request body."""
    text: str = Field(..., min_length=1, max_length=5000, description="Text to convert to speech")
    voice: str = Field(default="en-US-AriaNeural", description="Voice ID")
    rate: str = Field(default="+0%", description="Speed adjustment (e.g., +20%, -10%)")
    pitch: str = Field(default="+0Hz", description="Pitch adjustment (e.g., +5Hz, -10Hz)")


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "Read-Aloud TTS API"}


@app.get("/api/voices")
async def list_voices(locale: Optional[str] = None):
    """List available voices, optionally filtered by locale."""
    if locale:
        filtered = {k: v for k, v in VOICES.items() if v["locale"].startswith(locale)}
        return {"voices": filtered}
    return {"voices": VOICES}


@app.get("/api/voices/{locale}")
async def get_voices_by_locale(locale: str):
    """Get voices for a specific locale (e.g., en-US, es-ES)."""
    filtered = {k: v for k, v in VOICES.items() if v["locale"] == locale or v["locale"].startswith(locale.split("-")[0])}
    if not filtered:
        raise HTTPException(status_code=404, detail=f"No voices found for locale: {locale}")
    return {"voices": filtered}


@app.post("/api/tts")
async def text_to_speech(request: Request, body: TTSRequest):
    """
    Convert text to speech using Edge TTS neural voices.

    Returns an audio/mpeg stream that can be played directly.
    """
    if not _origin_allowed(request):
        raise HTTPException(status_code=403, detail="origin not allowed")

    if not check_rate_limit(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Please wait a moment.")

    # Validate voice
    if body.voice not in VOICES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid voice: {body.voice}. Use GET /api/voices to see available options."
        )

    # Validate rate format
    if not (body.rate.endswith("%") and body.rate[:-1].lstrip("+-").isdigit()):
        raise HTTPException(status_code=400, detail="Invalid rate format. Use +20% or -10%")

    _t0 = time.time()
    char_count = len(body.text)

    cache_key = hashlib.sha256(
        f"{body.text}|{body.voice}|{body.rate}|{body.pitch}".encode("utf-8")
    ).hexdigest()
    cached = audio_cache.get(cache_key)
    if cached is not None:
        _usage_log(body.voice, char_count, True, int((time.time() - _t0) * 1000))
        return StreamingResponse(
            io.BytesIO(cached),
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=3600",
                "X-Cache": "hit",
            },
        )

    # Generate audio
    try:
        communicate = edge_tts.Communicate(
            text=body.text,
            voice=body.voice,
            rate=body.rate,
            pitch=body.pitch
        )

        audio_stream = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_stream.write(chunk["data"])

        audio_bytes = audio_stream.getvalue()
        audio_cache.put(cache_key, audio_bytes)
        _usage_log(body.voice, char_count, False, int((time.time() - _t0) * 1000))

        return StreamingResponse(
            io.BytesIO(audio_bytes),
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=3600",
                "X-Cache": "miss",
            },
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {str(e)}")


@app.get("/api/tts")
async def text_to_speech_get(
    request: Request,
    text: str,
    voice: str = "en-US-AriaNeural",
    rate: str = "+0%",
    pitch: str = "+0Hz"
):
    """GET endpoint for simple TTS (useful for <audio> src)."""
    body = TTSRequest(text=text, voice=voice, rate=rate, pitch=pitch)
    return await text_to_speech(request, body)


# ----------------------------------------------------------------------
# Local-only usage dashboard
# Disabled unless both TTS_USAGE_DB and TTS_ADMIN_TOKEN env vars are set.
# Returns a server-rendered HTML page; no JS, no chart library.
# ----------------------------------------------------------------------
ADMIN_TOKEN = os.environ.get("TTS_ADMIN_TOKEN")


@app.get("/admin/stats")
async def admin_stats(request: Request, token: Optional[str] = None):
    if not USAGE_DB_PATH or not ADMIN_TOKEN:
        raise HTTPException(status_code=404, detail="Not found")
    supplied = token or request.headers.get("x-admin-token", "")
    # constant-time comparison
    import hmac
    if not hmac.compare_digest(supplied, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")

    conn = sqlite3.connect(USAGE_DB_PATH, timeout=2)
    conn.row_factory = sqlite3.Row

    def q(sql, *args):
        return [dict(r) for r in conn.execute(sql, args).fetchall()]

    today = q(
        "SELECT COUNT(*) AS reqs, COALESCE(SUM(char_count),0) AS chars, "
        "COALESCE(SUM(cache_hit),0) AS hits, COALESCE(AVG(duration_ms),0) AS avg_ms "
        "FROM tts_requests WHERE ts >= datetime('now','-24 hours')"
    )[0]
    all_time = q(
        "SELECT COUNT(*) AS reqs, COALESCE(SUM(char_count),0) AS chars, "
        "MIN(ts) AS first_seen FROM tts_requests"
    )[0]
    daily = q(
        "SELECT date(ts) AS d, COUNT(*) AS n, SUM(char_count) AS chars "
        "FROM tts_requests WHERE ts >= datetime('now','-14 days') "
        "GROUP BY date(ts) ORDER BY d"
    )
    voices = q(
        "SELECT voice, COUNT(*) AS n, SUM(char_count) AS chars "
        "FROM tts_requests WHERE ts >= datetime('now','-7 days') "
        "GROUP BY voice ORDER BY n DESC LIMIT 12"
    )
    buckets = q(
        "SELECT CASE "
        "  WHEN char_count < 100 THEN '<100' "
        "  WHEN char_count < 500 THEN '100-500' "
        "  WHEN char_count < 2000 THEN '500-2k' "
        "  WHEN char_count < 5000 THEN '2k-5k' "
        "  ELSE '5k+' END AS bucket, COUNT(*) AS n "
        "FROM tts_requests WHERE ts >= datetime('now','-7 days') "
        "GROUP BY bucket ORDER BY MIN(char_count)"
    )
    hourly = q(
        "SELECT strftime('%H', ts) AS h, COUNT(*) AS n "
        "FROM tts_requests WHERE ts >= datetime('now','-24 hours') "
        "GROUP BY h ORDER BY h"
    )
    conn.close()

    hit_pct = (today["hits"] / today["reqs"] * 100) if today["reqs"] else 0
    max_daily = max((d["n"] for d in daily), default=1) or 1
    max_hourly = max((h["n"] for h in hourly), default=1) or 1
    max_voice = max((v["n"] for v in voices), default=1) or 1
    max_bucket = max((b["n"] for b in buckets), default=1) or 1

    def bar_row(label, n, total, max_n, extra=""):
        pct = (n / max_n * 100) if max_n else 0
        return (
            f'<tr><td class="lbl">{label}</td>'
            f'<td class="num">{n:,}</td>'
            f'<td class="bar"><span style="width:{pct:.1f}%"></span></td>'
            f'<td class="num">{extra}</td></tr>'
        )

    daily_rows = "".join(bar_row(d["d"], d["n"], None, max_daily, f"{d['chars']:,} ch") for d in daily) or '<tr><td colspan="4" class="muted">No data yet.</td></tr>'
    voice_rows = "".join(bar_row(v["voice"], v["n"], None, max_voice, f"{v['chars']:,} ch") for v in voices) or '<tr><td colspan="4" class="muted">No data yet.</td></tr>'
    bucket_rows = "".join(bar_row(b["bucket"], b["n"], None, max_bucket) for b in buckets) or '<tr><td colspan="3" class="muted">No data yet.</td></tr>'
    hour_rows = "".join(bar_row(h["h"] + ":00", h["n"], None, max_hourly) for h in hourly) or '<tr><td colspan="3" class="muted">No data yet.</td></tr>'

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>Read-Aloud · Usage</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Source+Serif+4:wght@400;600&family=Space+Mono:wght@400;700&display=swap');
:root {{
  --paper:#f3ecdd;--surface:#faf4e6;--ink:#1a1c22;--ink-soft:#3f3f3a;
  --ink-faded:#6f6857;--rule:#b8aa8a;--rule-soft:#d6c8a8;--vermilion:#c8341e;
  --shadow:4px 4px 0 0 var(--ink);
}}
body {{font-family:"Source Serif 4",Georgia,serif;background:var(--paper);color:var(--ink);
  margin:0;padding:32px 24px;max-width:980px;margin-left:auto;margin-right:auto;}}
h1 {{font-family:"Fraunces",serif;font-weight:500;font-size:2.2rem;
  letter-spacing:-.02em;margin:0 0 4px;font-variation-settings:"opsz" 144;}}
h1 em {{font-style:italic;color:var(--vermilion);}}
h2 {{font-family:"Fraunces",serif;font-weight:500;font-size:1.2rem;
  margin:32px 0 8px;border-bottom:1px solid var(--ink);padding-bottom:6px;}}
.eyebrow {{font-family:"Space Mono",monospace;font-size:.7rem;
  letter-spacing:.2em;text-transform:uppercase;color:var(--ink-faded);
  margin:0 0 24px;}}
.cards {{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:16px;margin:16px 0 24px;}}
.card {{background:var(--surface);border:1px solid var(--ink);box-shadow:var(--shadow);
  padding:16px;}}
.card .lbl {{font-family:"Space Mono",monospace;font-size:.68rem;
  letter-spacing:.2em;text-transform:uppercase;color:var(--ink-faded);
  margin:0 0 6px;}}
.card .val {{font-family:"Fraunces",serif;font-weight:500;font-size:1.8rem;
  letter-spacing:-.02em;line-height:1;font-variation-settings:"opsz" 100;}}
.card .sub {{font-family:"Space Mono",monospace;font-size:.7rem;
  letter-spacing:.05em;color:var(--ink-faded);margin-top:4px;}}
table {{width:100%;border-collapse:collapse;font-family:"Source Serif 4",serif;
  font-size:.95rem;}}
table td {{padding:6px 10px;border-bottom:1px dotted var(--rule-soft);}}
.lbl {{font-family:"Space Mono",monospace;font-size:.78rem;letter-spacing:.04em;
  white-space:nowrap;width:140px;}}
.num {{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-faded);
  font-family:"Space Mono",monospace;font-size:.78rem;white-space:nowrap;}}
.bar {{width:60%;}}
.bar span {{display:block;height:14px;background:var(--vermilion);
  box-shadow:1px 1px 0 0 var(--ink);}}
.muted {{color:var(--ink-faded);font-style:italic;}}
.foot {{font-family:"Space Mono",monospace;font-size:.7rem;letter-spacing:.06em;
  color:var(--ink-faded);margin-top:32px;padding-top:14px;
  border-top:1px solid var(--ink);}}
</style></head>
<body>
<p class="eyebrow">Read-Aloud · Usage telemetry · auto-refresh 60s</p>
<h1>Who's using the <em>instrument.</em></h1>

<div class="cards">
  <div class="card"><p class="lbl">Last 24 hrs</p><p class="val">{today['reqs']:,}</p><p class="sub">requests</p></div>
  <div class="card"><p class="lbl">Characters</p><p class="val">{today['chars']:,}</p><p class="sub">read aloud</p></div>
  <div class="card"><p class="lbl">Cache hit</p><p class="val">{hit_pct:.0f}%</p><p class="sub">{today['hits']:,} of {today['reqs']:,}</p></div>
  <div class="card"><p class="lbl">Avg latency</p><p class="val">{int(today['avg_ms']):,}<span style="font-size:.5em">ms</span></p><p class="sub">end to end</p></div>
</div>

<h2>Daily, last 14 days</h2>
<table><tbody>{daily_rows}</tbody></table>

<h2>Hourly, last 24 hrs</h2>
<table><tbody>{hour_rows}</tbody></table>

<h2>Top voices, last 7 days</h2>
<table><tbody>{voice_rows}</tbody></table>

<h2>Text length distribution, last 7 days</h2>
<table><tbody>{bucket_rows}</tbody></table>

<p class="foot">All-time: {all_time['reqs']:,} requests, {all_time['chars']:,} characters
since {all_time['first_seen'] or 'never'}. Local mini-PC telemetry; no IPs, no text content.</p>
</body></html>"""

    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
