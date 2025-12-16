#!/usr/bin/env python3
# providers.py — placeholder voice registry

"""Placeholder provider registry with external TTS disabled.

Premium text-to-speech integrations have been removed. This module now
only exposes a stub ``list_public_voices`` helper so the API can respond
without attempting to contact external services.
"""

from typing import Dict, Any


# Empty voice registry maintained for compatibility with the API
VOICES: Dict[str, Dict[str, Any]] = {}


def list_public_voices() -> list:
    """Return a list of available voices (currently none)."""

    return []
