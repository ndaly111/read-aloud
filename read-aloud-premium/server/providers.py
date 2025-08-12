#!/usr/bin/env python3
# providers.py — TTS adapters for Google + ElevenLabs

"""Text-to-speech provider adapters for Google Cloud and ElevenLabs.

This module exposes a simple API for synthesizing speech using either
Google Cloud Text-to-Speech or ElevenLabs. It also defines a minimal
voice registry used by the premium demo and paid endpoints. Each entry
in the ``VOICES`` dictionary contains metadata about the voice,
including whether it should be considered premium and the default
speaking rate. Providers not configured (e.g. ElevenLabs without an
API key) will raise a ``RuntimeError`` when invoked.
"""

import os
import pathlib
from typing import Dict, Any

# Directory where any cache or temporary files could be stored. This
# ensures the directory exists on import. In production you may wish
# to direct this to a persistent location such as an S3 bucket.
CACHE_DIR = pathlib.Path(__file__).resolve().parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Voice registry. Each voice entry uses a unique key. The values
# include the provider ("google" or "elevenlabs"), a human‑friendly
# label, the provider-specific voice identifier, a ``premium`` flag,
# and a default speaking rate. Feel free to expand this list with
# additional languages and voices as needed.
VOICES: Dict[str, Dict[str, Any]] = {
    # Google Neural voices (high quality, reasonable cost). These
    # voices use the Neural2 engine. See Google Cloud docs for
    # additional voice names.
    "google_en_us_neural_f": {
        "provider": "google",
        "label": "English (US) — Female — Neural2-F",
        "voice_name": "en-US-Neural2-F",
        "premium": False,
        "rate_default": 1.0,
    },
    "google_en_us_neural_m": {
        "provider": "google",
        "label": "English (US) — Male — Neural2-M",
        "voice_name": "en-US-Neural2-M",
        "premium": False,
        "rate_default": 1.0,
    },

    # Example ElevenLabs voice. To enable this, set the
    # ELEVENLABS_API_KEY environment variable. Replace the
    # ``voice_id`` with a voice from your ElevenLabs account.
    "11labs_rachel": {
        "provider": "elevenlabs",
        "label": "ElevenLabs — Rachel (Premium)",
        "voice_id": "21m00Tcm4TlvDq8ikWAM",
        "premium": True,
        "rate_default": 1.0,
    },
}

def list_public_voices() -> list:
    """Return a list of public voice metadata.

    Each element is a dict containing the key, label and whether the
    voice is premium. This is used by the API to expose available
    voices to clients.
    """
    return [
        {"key": key, "label": data["label"], "premium": data["premium"]}
        for key, data in VOICES.items()
    ]


def synth(text: str, key: str, speaking_rate: float = 1.0) -> bytes:
    """Synthesize speech using the specified voice.

    Args:
        text: The text to synthesize. Should already be validated and
            length‑restricted by the caller.
        key: The key identifying the voice to use.
        speaking_rate: Optional speaking rate multiplier. A value of
            1.0 produces normal speed; adjust between 0.5 and 1.5.

    Returns:
        MP3 audio bytes.

    Raises:
        ValueError: If the voice key is unknown.
        RuntimeError: If the requested provider is unsupported or not
            configured.
    """
    voice = VOICES.get(key)
    if not voice:
        raise ValueError(f"Unknown voice key: {key}")

    provider = voice["provider"]
    if provider == "google":
        # Use Google Cloud Text-to-Speech. Requires the client library
        # and credentials file configured via the
        # GOOGLE_APPLICATION_CREDENTIALS environment variable.
        from google.cloud import texttospeech as tts
        client = tts.TextToSpeechClient()
        input_text = tts.SynthesisInput(text=text)
        voice_params = tts.VoiceSelectionParams(
            language_code="en-US", name=voice["voice_name"]
        )
        audio_cfg = tts.AudioConfig(
            audio_encoding=tts.AudioEncoding.MP3,
            speaking_rate=speaking_rate,
        )
        response = client.synthesize_speech(
            input=input_text, voice=voice_params, audio_config=audio_cfg
        )
        return response.audio_content

    if provider == "elevenlabs":
        # Use ElevenLabs via HTTP API. Requires ELEVENLABS_API_KEY.
        api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY not set. Premium voices are disabled."
            )
        import httpx
        import json
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice['voice_id']}"
        headers = {
            "xi-api-key": api_key,
            "accept": "audio/mpeg",
            "Content-Type": "application/json",
        }
        payload = {
            "text": text,
            "model_id": "eleven_turbo_v2",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
        }
        with httpx.Client(timeout=90) as client:
            resp = client.post(url, headers=headers, data=json.dumps(payload))
            if resp.status_code != 200:
                raise RuntimeError(
                    f"ElevenLabs {resp.status_code}: {resp.text[:200]}"
                )
            return resp.content

    raise RuntimeError(f"Unsupported provider: {provider}")
