#!/usr/bin/env python3
# voice_demo_server.py — Voice preview API for the free demo

"""Simple FastAPI service exposing voice previews.

This module implements a minimal API for listing available voices and
generating short preview samples. It uses the voice provider adapters
from ``providers.py`` and stores synthesized previews on disk. The
design of this server allows you to offer free previews without
consuming paid character credits. For a more complete premium flow,
see ``premium_api.py``.
"""

import os
import hashlib
import pathlib
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .providers import list_public_voices, synth


# Configure cache directory. All preview audio files are stored under
# ``cache/demos`` relative to this file.
BASE_DIR = pathlib.Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache" / "demos"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Limit preview length. Text longer than this will be truncated.
PREVIEW_MAX_CHARS = 300  # roughly 10–15 seconds at normal speed

# Default preview text if none is supplied by the client.
DEFAULT_PREVIEW_TEXT = (
    "This is a short voice preview from read‑aloud dot com."
)


def _cache_path(key: str, text: str, rate: float) -> pathlib.Path:
    """Compute the cache file path based on voice key, text and rate."""
    h = hashlib.sha256(f"{key}|{rate}|{text}".encode("utf-8")).hexdigest()[:16]
    return CACHE_DIR / f"{key}_{h}.mp3"


# FastAPI app
app = FastAPI(title="read‑aloud Voice Demo API")


class VoicesOut(BaseModel):
    voices: List[Dict[str, Any]]


@app.get("/api/voices", response_model=VoicesOut)
def list_voices() -> dict:
    """Return the list of available voices for previews."""
    return {"voices": list_public_voices()}


@app.get("/api/preview")
def preview(
    voice: str = Query(..., description="Voice key from /api/voices"),
    text: Optional[str] = Query(None),
    rate: float = Query(1.0, ge=0.5, le=1.5),
) -> dict:
    """Generate or return a cached voice preview.

    Clients may specify custom text (e.g. to test specific
    pronunciations); otherwise the default preview text is used. The
    preview is truncated to ``PREVIEW_MAX_CHARS`` characters.
    """
    sample = (text or DEFAULT_PREVIEW_TEXT).strip()
    if len(sample) > PREVIEW_MAX_CHARS:
        sample = sample[:PREVIEW_MAX_CHARS]
    path = _cache_path(voice, sample, rate)
    if path.exists() and path.stat().st_size > 1000:
        return {"url": f"/api/file/{path.name}", "cached": True}
    # Synthesize using provider
    audio = synth(sample, voice, speaking_rate=rate)
    path.write_bytes(audio)
    return {"url": f"/api/file/{path.name}", "cached": False}


@app.get("/api/file/{fname}")
def serve_file(fname: str) -> FileResponse:
    """Serve a cached preview MP3."""
    path = CACHE_DIR / fname
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(path), media_type="audio/mpeg", filename=fname)
