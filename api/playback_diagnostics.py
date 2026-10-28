"""Bounded operational logs. Never accept text, email, raw errors or full UAs."""
import json
import hashlib
import logging
import re
import sqlite3
import time
import traceback
from collections import OrderedDict
from contextlib import contextmanager
from threading import Lock
from typing import Literal, Optional

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("readaloud.diagnostics")
EVENTS = Literal[
    "start", "heartbeat", "visibility", "playing", "unexpected_pause",
    "waiting", "stalled", "audio_error", "play_rejected", "voice_error",
    "speech_restart", "fetch_error", "reading_error", "user_pause",
    "user_resume", "stop", "finish", "fetch_recovered",
    "loop_change", "loop_gap_start", "loop_gap_end", "voice_change", "language_change",
    "rate_change", "volume_change", "seek", "export_start", "export_finish", "export_error",
    "runtime_error", "unhandled_rejection", "resource_error", "no_progress", "feedback",
    "online", "offline", "page_freeze", "page_resume", "page_exit",
]
READING_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class CodeFrame(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    file: Literal["readaloud.js", "playback-diagnostics.js", "file-upload.js", "index.html",
                  "tts_server.py", "playback_diagnostics.py", "backup_tts.py"]
    line: int = Field(ge=0, le=1000000)
    column: int = Field(ge=0, le=1000000)


class Breadcrumb(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    event: EVENTS
    elapsed_ms: int = Field(ge=0, le=86400000)
    position: int = Field(ge=0, le=10000000)
    segment: int = Field(ge=-1, le=100000)
    phase: Literal["idle", "loading", "playing", "paused", "loop-gap", "ended", "exporting"] = "idle"
    rate: float = Field(default=1.0, ge=0.1, le=10)
    loop_on: bool = False
    loop_gap_sec: int = Field(default=0, ge=0, le=600)


ERROR_NAMES = Literal["", "Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError",
    "URIError", "EvalError", "DOMException", "NotAllowedError", "AbortError", "NotSupportedError",
    "InvalidStateError", "SecurityError", "NetworkError", "TimeoutError", "ValueError",
    "RuntimeError", "AssertionError", "KeyError", "OSError"]


class FailureReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["uncaught-error", "unhandled-rejection", "resource-error", "no-progress",
                  "feedback", "export-error", "playback-error", "server-error"]
    error_name: ERROR_NAMES = ""
    frames: list[CodeFrame] = Field(default_factory=list, max_length=6)
    breadcrumbs: list[Breadcrumb] = Field(default_factory=list, max_length=12)


class PlaybackEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    reading_id: str = Field(pattern=READING_ID.pattern)
    seq: int = Field(ge=1, le=200)
    event: EVENTS
    elapsed_ms: int = Field(ge=0, le=86400000)
    build: str = Field(pattern=r"^[0-9]{8}[a-z0-9-]{0,20}$")
    reader_build: str = Field(default="", pattern=r"^(|[0-9]{8}[a-z0-9-]{0,20})$")
    source: Literal["premium", "browser", "page"]
    voice: str = Field(pattern=r"^(device|[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]{1,50}Neural)$")
    language: str = Field(pattern=r"^[a-z]{2,3}$")
    browser: Literal["Chrome", "Edge", "Firefox", "Safari", "Samsung", "other"]
    browser_major: int = Field(ge=0, le=999)
    os: Literal["Android", "iOS", "Windows", "macOS", "Linux", "other"]
    position: int = Field(ge=0, le=10000000)
    total_chars: int = Field(ge=0, le=10000000)
    segment: int = Field(ge=-1, le=100000)
    media_time_ms: int = Field(ge=0, le=86400000)
    media_duration_ms: int = Field(ge=0, le=86400000)
    media_paused: bool
    media_muted: bool
    speaking: bool
    paused: bool
    speech_speaking: bool
    speech_pending: bool
    speech_paused: bool
    visibility: Literal["visible", "hidden"]
    online: bool
    rate: float = Field(ge=0.1, le=10)
    volume: float = Field(ge=0, le=1)
    code: str = Field(default="", pattern=r"^(|unknown|no-progress|timeout|abort|network|invalid-response|invalid-audio|audio-too-small|incomplete-audio|wrong-engine|not-allowed|interrupted|canceled|synthesis-failed|synthesis-unavailable|audio-busy|audio-hardware|language-unavailable|voice-unavailable|invalid-argument|text-too-long|audio-[1-4]|http-[1-5][0-9]{2})$")
    phase: Literal["idle", "loading", "playing", "paused", "loop-gap", "ended", "exporting"] = "idle"
    selected_voice: str = Field(default="device", pattern=r"^(device|[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]{1,50}Neural)$")
    selected_language: str = Field(default="en", pattern=r"^[a-z]{2,3}$")
    loop_on: bool = False
    loop_gap_active: bool = False
    loop_gap_sec: int = Field(default=0, ge=0, le=600)
    loop_remaining_ms: int = Field(default=0, ge=0, le=600000)
    segment_count: int = Field(default=0, ge=0, le=100000)
    ready_state: int = Field(default=0, ge=0, le=4)
    network_state: int = Field(default=0, ge=0, le=3)
    export_type: Literal["", "mp3", "subtitles"] = ""
    report: Optional[FailureReport] = None
    endpoint: Literal["", "primary", "render"] = ""
    request_id: int = Field(default=0, ge=0, le=1000000)
    attempt: int = Field(default=0, ge=0, le=4)
    request_start: int = Field(default=-1, ge=-1, le=10000000)
    request_chars: int = Field(default=0, ge=0, le=10000)
    request_ms: int = Field(default=0, ge=0, le=120000)
    http_status: int = Field(default=0, ge=0, le=599)
    stage: Literal["", "network", "response", "decode", "validation", "complete"] = ""
    audio_bytes: int = Field(default=0, ge=0, le=50000000)
    expected_chars: int = Field(default=0, ge=0, le=10000)
    returned_chars: int = Field(default=-1, ge=-1, le=10000)


class DiagnosticStore:
    RETENTION_SECONDS = 30 * 86400
    MAX_ROWS = 50000
    MAX_REPORTS = 5000

    def __init__(self, path):
        self.path = path
        self.lock = Lock()
        self.last_prune = 0
        if path:
            try:
                with self.connect() as db:
                    db.execute("CREATE TABLE IF NOT EXISTS diagnostic_events ("
                               "id INTEGER PRIMARY KEY, created_at REAL NOT NULL, "
                               "reading_id TEXT, event TEXT NOT NULL, payload TEXT NOT NULL)")
                    db.execute("CREATE INDEX IF NOT EXISTS diagnostics_reading ON diagnostic_events(reading_id,id)")
                    db.execute("CREATE INDEX IF NOT EXISTS diagnostics_created ON diagnostic_events(created_at)")
                    db.execute("CREATE TABLE IF NOT EXISTS diagnostic_reports ("
                               "id INTEGER PRIMARY KEY, created_at REAL NOT NULL, "
                               "reading_id TEXT, event TEXT NOT NULL, payload TEXT NOT NULL)")
                    db.execute("CREATE INDEX IF NOT EXISTS reports_reading ON diagnostic_reports(reading_id,id)")
                    db.execute("CREATE INDEX IF NOT EXISTS reports_created ON diagnostic_reports(created_at)")
            except Exception:
                self.path = None
                log.warning("Diagnostic storage unavailable")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=0.2)
        try:
            with db:
                yield db
        finally:
            db.close()

    def write(self, reading_id, event, payload):
        if not self.path:
            return False
        try:
            with self.lock, self.connect() as db:
                now = time.time()
                if payload.get("report"):
                    report = payload["report"]
                    identity = [report["kind"], report.get("error_name", ""), report.get("frames", []),
                                payload.get("code", ""), payload.get("status", 0),
                                payload.get("reader_build", "")]
                    signature = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
                    payload = {**payload, "report": {**report, "signature": signature}}
                    report_cursor = db.execute("INSERT INTO diagnostic_reports(created_at,reading_id,event,payload) VALUES(?,?,?,?)",
                                               (now, reading_id, event, json.dumps(payload, separators=(",", ":"))))
                    db.execute("DELETE FROM diagnostic_reports WHERE id <= ?", (report_cursor.lastrowid - self.MAX_REPORTS,))
                cursor = db.execute("INSERT INTO diagnostic_events(created_at,reading_id,event,payload) VALUES(?,?,?,?)",
                                    (now, reading_id, event, json.dumps(payload, separators=(",", ":"))))
                # IDs can have gaps after expiry; this still bounds rows and
                # avoids scanning 50,000 rows for every incoming event.
                db.execute("DELETE FROM diagnostic_events WHERE id <= ?", (cursor.lastrowid - self.MAX_ROWS,))
                if now - self.last_prune >= 60:
                    db.execute("DELETE FROM diagnostic_events WHERE created_at < ?", (now - self.RETENTION_SECONDS,))
                    db.execute("DELETE FROM diagnostic_reports WHERE created_at < ?", (now - self.RETENTION_SECONDS,))
                    self.last_prune = now
            return True
        except Exception:
            # A locked/full/unavailable DB must never turn a TTS request into a failure.
            log.warning("Diagnostic write failed")
            return False

    def read(self, reading_id=None, limit=100, reports=False):
        with self.lock, self.connect() as db:
            table = "diagnostic_reports" if reports else "diagnostic_events"
            sql = f"SELECT id,created_at,reading_id,event,payload FROM {table} WHERE created_at >= ?"
            params = [time.time() - self.RETENTION_SECONDS]
            if reading_id:
                sql += " AND reading_id = ?"
                params.append(reading_id)
            params.append(limit)
            rows = db.execute(sql + " ORDER BY id DESC LIMIT ?", params).fetchall()
        return [dict(id=r[0], created_at=r[1], reading_id=r[2], event=r[3], data=json.loads(r[4])) for r in rows]


def install_diagnostics(app, path, origins, admin_token):
    import hmac
    store = DiagnosticStore(path)
    app.state.diagnostic_store = store
    buckets = OrderedDict()

    @app.post("/api/diagnostics", status_code=204)
    async def ingest(request: Request):
        # Exact match: read-aloud.com.evil.example must never pass.
        if request.headers.get("origin", "") not in origins:
            raise HTTPException(403, "origin not allowed")
        if not store.path:
            raise HTTPException(503, "Diagnostics unavailable")
        # Independent quota, so logs cannot consume a reader's TTS allowance.
        ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")
        now = time.monotonic()
        started, count = buckets.pop(ip, (now, 0))
        if now - started >= 60:
            started, count = now, 0
        buckets[ip] = (started, count + 1)
        if len(buckets) > 5000:
            buckets.popitem(last=False)
        if count >= 120:
            raise HTTPException(429, "Diagnostic rate limit")
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 8192:
                raise HTTPException(413, "Diagnostic payload too large")
        try:
            data = PlaybackEvent.model_validate(json.loads(raw))
        except Exception:
            # Do not echo/log validation input; it may contain pasted text.
            raise HTTPException(400, "Invalid diagnostic event")
        if not await run_in_threadpool(store.write, data.reading_id, data.event, data.model_dump()):
            raise HTTPException(503, "Diagnostics unavailable")

    @app.get("/admin/playback-logs")
    @app.get("/admin/crash-reports")
    async def review(request: Request, reading_id: Optional[str] = None, limit: int = 100):
        if not store.path or not admin_token:
            raise HTTPException(404, "Not found")
        if not hmac.compare_digest(request.headers.get("x-admin-token", "").encode(), admin_token.encode()):
            raise HTTPException(401, "Unauthorized")
        if reading_id and not READING_ID.fullmatch(reading_id):
            raise HTTPException(400, "Invalid reading ID")
        try:
            return await run_in_threadpool(store.read, reading_id, max(1, min(limit, 500)),
                                           request.url.path == "/admin/crash-reports")
        except Exception:
            raise HTTPException(503, "Diagnostics unavailable")

    @app.middleware("http")
    async def log_tts_failures(request: Request, call_next):
        if request.url.path not in ("/api/tts", "/api/tts/timed") or request.method != "POST":
            return await call_next(request)
        started = time.monotonic()
        reading_id = request.headers.get("x-reading-id", "")
        reading_id = reading_id if READING_ID.fullmatch(reading_id) else None
        # Numeric attempt identity only; never copy arbitrary header contents.
        def bounded_header(name, maximum):
            value = request.headers.get(name, "")
            return int(value) if re.fullmatch(r"[0-9]{1,7}", value) and int(value) <= maximum else 0
        request_id = bounded_header("x-tts-request-id", 1000000)
        attempt = bounded_header("x-tts-attempt", 4)
        status = 500
        report = {"kind": "server-error", "error_name": "", "frames": [], "breadcrumbs": []}
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        except Exception as exc:
            # Exception messages and source-code excerpts may include user text.
            allowed_names = {"TypeError", "ValueError", "RuntimeError", "AssertionError", "KeyError", "OSError", "TimeoutError"}
            report["error_name"] = type(exc).__name__ if type(exc).__name__ in allowed_names else ""
            for entry in traceback.extract_tb(exc.__traceback__):
                file = entry.filename.replace("\\", "/").split("/")[-1]
                if file in {"tts_server.py", "playback_diagnostics.py", "backup_tts.py"}:
                    report["frames"].append({"file": file, "line": min(entry.lineno, 1000000), "column": 0})
            report["frames"] = report["frames"][-6:]
            raise
        finally:
            if status >= 400:
                await run_in_threadpool(store.write, reading_id, "tts_failure", {
                    "path": request.url.path, "status": status,
                    "duration_ms": round((time.monotonic() - started) * 1000),
                    "request_id": request_id, "attempt": attempt,
                    **({"report": report} if status >= 500 else {}),
                })
    return store
