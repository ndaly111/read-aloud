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
import io
import os
from typing import Optional

import edge_tts
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(
    title="Read-Aloud TTS API",
    description="High-quality text-to-speech using neural voices",
    version="1.0.0"
)

# CORS - allow your domain
ALLOWED_ORIGINS = [
    "https://read-aloud.com",
    "https://www.read-aloud.com",
    "http://localhost:4000",  # Jekyll dev server
    "http://127.0.0.1:4000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Rate limiting (simple in-memory, use Redis in production)
from collections import defaultdict
from datetime import datetime, timedelta

request_counts = defaultdict(list)
RATE_LIMIT = 50  # requests per minute
RATE_WINDOW = 60  # seconds


def check_rate_limit(ip: str) -> bool:
    """Simple rate limiting by IP."""
    now = datetime.now()
    cutoff = now - timedelta(seconds=RATE_WINDOW)

    # Clean old requests
    request_counts[ip] = [t for t in request_counts[ip] if t > cutoff]

    if len(request_counts[ip]) >= RATE_LIMIT:
        return False

    request_counts[ip].append(now)
    return True


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
    # Rate limiting
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
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

    # Generate audio
    try:
        communicate = edge_tts.Communicate(
            text=body.text,
            voice=body.voice,
            rate=body.rate,
            pitch=body.pitch
        )

        # Stream the audio
        audio_stream = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_stream.write(chunk["data"])

        audio_stream.seek(0)

        return StreamingResponse(
            audio_stream,
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=3600"
            }
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


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
