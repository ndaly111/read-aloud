"""Local diagnostic ingestion, privacy, access and retention checks; no network."""
import json
import sqlite3
import tempfile
import time
from contextlib import closing
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from playback_diagnostics import install_diagnostics

ID = "b48e0c45-31c6-4c07-9363-973e7418cfaa"
ORIGIN = "https://read-aloud.com"
EVENT = dict(
    reading_id=ID, seq=1, event="unexpected_pause", elapsed_ms=30000,
    build="20261004diag1", source="premium", voice="en-US-AriaNeural", language="en",
    browser="Chrome", browser_major=154, os="Android", position=420, total_chars=1200,
    segment=0, media_time_ms=30000, media_duration_ms=69000, media_paused=True,
    media_muted=False, speaking=True, paused=False, speech_speaking=False,
    speech_pending=False, speech_paused=False, visibility="hidden", online=True,
    rate=1.0, volume=1.0, code="",
)


def make_app(path, token="test-token"):
    app = FastAPI()
    store = install_diagnostics(app, str(path) if path else None, [ORIGIN], token)

    @app.post("/api/tts/timed")
    async def failing_tts():
        raise HTTPException(504, "secret upstream message must not be stored")

    return TestClient(app), store


with tempfile.TemporaryDirectory() as directory:
    dbpath = Path(directory) / "diagnostics.sqlite"
    client, store = make_app(dbpath)
    headers = {"Origin": ORIGIN}
    assert client.post("/api/diagnostics", json=EVENT, headers=headers).status_code == 204
    assert store.read(ID)[0]["data"]["media_time_ms"] == 30000
    assert client.get("/admin/playback-logs").status_code == 401
    assert client.get("/admin/playback-logs?token=test-token").status_code == 401
    reviewed = client.get("/admin/playback-logs", params={"reading_id": ID}, headers={"X-Admin-Token": "test-token"})
    assert reviewed.status_code == 200 and len(reviewed.json()) == 1
    assert client.post("/api/diagnostics", json=EVENT, headers={"Origin": ORIGIN + ".evil.example"}).status_code == 403
    assert client.post("/api/diagnostics", json={**EVENT, "text": "private passage"}, headers=headers).status_code == 400
    assert client.post("/api/diagnostics", json={**EVENT, "code": "private exception text"}, headers=headers).status_code == 400
    assert client.post("/api/diagnostics", json={**EVENT, "browser": "full user agent"}, headers=headers).status_code == 400
    assert client.post("/api/diagnostics", content=b"x" * 4097, headers=headers).status_code == 413
    assert len(store.read()) == 1

    response = client.post("/api/tts/timed", json={"text": "private passage"}, headers={**headers, "X-Reading-ID": ID,
        "X-TTS-Request-ID": "17", "X-TTS-Attempt": "3"})
    assert response.status_code == 504
    failure = store.read(ID)[0]
    assert failure["event"] == "tts_failure" and failure["data"]["status"] == 504
    assert failure["data"]["request_id"] == 17 and failure["data"]["attempt"] == 3
    enhanced = {**EVENT, "event": "fetch_error", "reader_build": "20261010unicode1",
        "endpoint": "render", "request_id": 17, "attempt": 3, "request_start": 12043,
        "request_chars": 1185, "request_ms": 420, "http_status": 200,
        "stage": "validation", "code": "incomplete-audio", "expected_chars": 1185,
        "returned_chars": 1184, "audio_bytes": 200}
    assert client.post("/api/diagnostics", json=enhanced, headers=headers).status_code == 204
    assert store.read(ID)[0]["data"]["reader_build"] == "20261010unicode1"
    assert client.post("/api/diagnostics", json={**enhanced, "event": "fetch_recovered", "code": "", "stage": "complete"}, headers=headers).status_code == 204
    for field, value in [("endpoint", "https://private.example"), ("stage", "private error"),
                         ("reader_build", "private text"), ("request_id", 1000001), ("attempt", 5),
                         ("returned_chars", -2), ("request_start", -2), ("request_ms", "100")]:
        assert client.post("/api/diagnostics", json={**enhanced, field: value}, headers=headers).status_code == 400
    client.post("/api/tts/timed", json={}, headers={**headers, "X-Reading-ID": ID,
        "X-TTS-Request-ID": "private header", "X-TTS-Attempt": "99999"})
    assert store.read(ID)[0]["data"]["request_id"] == 0
    assert store.read(ID)[0]["data"]["attempt"] == 0
    serialized = json.dumps(store.read())
    for secret in ("private passage", "secret upstream", "test-token", "127.0.0.1", "private header"):
        assert secret not in serialized
    print("PASS ingestion, origin checks, protected review, privacy and correlated API failures")

    store.MAX_ROWS = 4
    for index in range(12):
        assert store.write(ID, "heartbeat", {"seq": index})
    assert len(store.read(limit=500)) == 4
    with closing(sqlite3.connect(dbpath)) as db, db:
        db.execute("UPDATE diagnostic_events SET created_at=? WHERE id=(SELECT min(id) FROM diagnostic_events)",
                   (time.time() - store.RETENTION_SECONDS - 1,))
    assert len(store.read()) == 3
    store.last_prune = 0
    store.write(ID, "finish", {})
    with closing(sqlite3.connect(dbpath)) as db, db:
        assert db.execute("SELECT count(*) FROM diagnostic_events WHERE created_at < ?",
                          (time.time() - store.RETENTION_SECONDS,)).fetchone()[0] == 0
    print("PASS row cap and expiry")

    with closing(sqlite3.connect(dbpath)) as locked, locked:
        locked.execute("BEGIN EXCLUSIVE")
        assert not store.write(ID, "heartbeat", {})
        # Original TTS response survives a diagnostic write failure.
        assert client.post("/api/tts/timed", json={}, headers=headers).status_code == 504
        locked.rollback()
    disabled, _ = make_app(None)
    assert disabled.post("/api/diagnostics", json=EVENT, headers=headers).status_code == 503
    assert disabled.post("/api/tts/timed", json={}, headers=headers).status_code == 504
    for _ in range(120):
        status = client.post("/api/diagnostics", json=EVENT, headers=headers).status_code
    assert status == 429
    print("PASS unavailable/locked storage never breaks synthesis; bounded independent quota")
