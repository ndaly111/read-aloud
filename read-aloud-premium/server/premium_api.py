#!/usr/bin/env python3
# premium_api.py — Free voice previews and paid MP3 generation via Stripe

"""FastAPI application for premium voice previews and one‑off MP3 purchases.

This module defines a small web API with three main features:

* ``/api/voices`` – List available voices for preview and generation.
* ``/api/preview`` – Synthesize a short preview (limited to 300
  characters) using any available voice. Responses are cached on
  disk to avoid repeated TTS requests for identical inputs.
* ``/api/file/{fname}`` – Serve cached preview MP3s and paid MP3s.
* ``/api/premium/checkout`` – Create a Stripe Checkout session for a
  one‑off premium MP3 purchase.
* ``/api/premium/mark_paid`` – Verify a Checkout session and mark it
  as paid (simplified MVP; in production use a Stripe webhook).
* ``/api/premium/generate`` – After payment, synthesize the full
  requested text and return a download link for the generated MP3.

Environment variables:

* ``STRIPE_SECRET_KEY`` – Your Stripe secret key.
* ``STRIPE_PUBLISHABLE_KEY`` – Your Stripe publishable key (not used
  directly by the backend but may be consumed by the frontend).
* ``STRIPE_PRICE_ID`` – The ID of a one‑time price in Stripe for the
  premium MP3 product.
* ``PREMIUM_SUCCESS_URL`` – URL template for redirect after a
  successful checkout. Should contain ``{CHECKOUT_SESSION_ID}`` which
  will be replaced by Stripe.
* ``PREMIUM_CANCEL_URL`` – URL to redirect to on cancellation.

Dependencies:

This API relies on ``fastapi``, ``uvicorn``, ``stripe``, and the
``read-aloud-premium.server.providers`` and ``read-aloud-premium.server.store``
modules. Ensure these are installed and configured properly.
"""

import os
import hashlib
import pathlib
import time
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .providers import list_public_voices, synth
from . import store


# Directory configuration. The preview cache and generated outputs are
# stored under ``cache/previews`` and ``out`` directories relative to
# this file. Make sure these directories are writable by the server.
BASE_DIR = pathlib.Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache" / "previews"
OUT_DIR = BASE_DIR / "out"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Limits for preview and full generation. Adjust these values if you
# need longer previews or allow longer paid syntheses. Text exceeding
# these limits will cause an HTTP 400 response.
PREVIEW_MAX_CHARS = 300     # roughly 10–15 seconds
GENERATE_MAX_CHARS = 20000  # safety cap for paid usage
DEFAULT_PREVIEW_TEXT = "This is a short voice preview from read‑aloud dot com."

# Stripe configuration from environment
STRIPE_SECRET = os.getenv("STRIPE_SECRET_KEY", "").strip()
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID", "").strip()
STRIPE_PUBLISHABLE = os.getenv("STRIPE_PUBLISHABLE_KEY", "").strip()

# Success and cancel redirect URLs. ``{CHECKOUT_SESSION_ID}`` is
# automatically replaced by Stripe when you create a checkout session.
SUCCESS_URL = os.getenv(
    "PREMIUM_SUCCESS_URL",
    "https://read-aloud.com/premium.html?session_id={CHECKOUT_SESSION_ID}",
)
CANCEL_URL = os.getenv(
    "PREMIUM_CANCEL_URL", "https://read-aloud.com/premium.html?canceled=1"
)

# FastAPI instance
app = FastAPI(title="read-aloud Premium API")



# Pydantic models for request/response validation
class VoicesOut(BaseModel):
    voices: list


class CheckoutIn(BaseModel):
    pass  # no body required for single-price checkout


class CheckoutOut(BaseModel):
    url: str


class GenerateIn(BaseModel):
    session_id: str
    voice: str
    text: str
    rate: float = 1.0


# Helper to compute deterministic file names based on content. This
# ensures that identical preview requests hit the same cache file and
# that paid outputs are uniquely named per session.
def _hash_name(prefix: str, payload: str) -> pathlib.Path:
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    directory = OUT_DIR if prefix == "paid" else CACHE_DIR
    return directory / f"{prefix}_{digest}.mp3"


@app.get("/api/voices", response_model=VoicesOut)
def voices() -> dict:
    """Return the list of available voices for preview and generation."""
    return {"voices": list_public_voices()}


@app.get("/api/preview")
def preview(
    voice: str = Query(..., description="Voice key from /api/voices"),
    text: Optional[str] = None,
    rate: float = Query(1.0, ge=0.5, le=1.5),
) -> dict:
    """Synthesize a short preview.

    This endpoint truncates the requested text to ``PREVIEW_MAX_CHARS``
    and caches the resulting MP3 to avoid duplicate provider calls.
    """
    sample = (text or DEFAULT_PREVIEW_TEXT).strip()
    if len(sample) > PREVIEW_MAX_CHARS:
        sample = sample[:PREVIEW_MAX_CHARS]
    # Check cache
    cache_file = _hash_name("demo", f"{voice}|{rate}|{sample}")
    if cache_file.exists() and cache_file.stat().st_size > 1000:
        return {"url": f"/api/file/{cache_file.name}", "cached": True}
    # Generate preview
    audio = synth(sample, voice, speaking_rate=rate)
    cache_file.write_bytes(audio)
    return {"url": f"/api/file/{cache_file.name}", "cached": False}


@app.get("/api/file/{fname}")
def serve_file(fname: str) -> FileResponse:
    """Serve an MP3 file from the cache or paid output directory."""
    directory = OUT_DIR if fname.startswith("paid_") else CACHE_DIR
    path = directory / fname
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(path), media_type="audio/mpeg", filename=fname)


@app.post("/api/premium/checkout", response_model=CheckoutOut)
def premium_checkout(_: CheckoutIn) -> dict:
    """Initiate a Stripe Checkout for a one‑off premium MP3."""
    if not STRIPE_SECRET or not STRIPE_PRICE_ID:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    import stripe

    stripe.api_key = STRIPE_SECRET
    # Create a checkout session for a single price. Use payment mode.
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
        success_url=SUCCESS_URL,
        cancel_url=CANCEL_URL,
        payment_intent_data={"description": "read-aloud Premium MP3"},
    )
    # Record the session ID in our store so we can later verify and
    # consume it when generating the paid MP3. If the insert already
    # exists, ``create_pending`` will simply no-op.
    store.create_pending(session.id)
    return {"url": session.url}


@app.post("/api/premium/mark_paid")
def mark_paid(session_id: str = Body(..., embed=True)) -> dict:
    """Verify a Stripe session and mark it as paid.

    For the MVP, the frontend can call this endpoint after redirect from
    Stripe Checkout to confirm the session has been paid. In a
    production system you should implement a Stripe webhook instead of
    calling this directly from a browser to avoid tampering.
    """
    if not STRIPE_SECRET:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    import stripe

    stripe.api_key = STRIPE_SECRET
    try:
        s = stripe.checkout.Session.retrieve(session_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Stripe error: {exc}")
    if s.get("payment_status") == "paid":
        store.mark_paid(session_id)
        return {"ok": True}
    return {"ok": False, "reason": "not_paid"}


@app.post("/api/premium/generate")
def generate(req: GenerateIn) -> dict:
    """Synthesize the full MP3 after payment.

    This endpoint checks that the provided ``session_id`` has been paid
    and not yet used. It then synthesizes the full text using the
    requested voice and returns a download link. Once used, the
    session is marked as used to prevent reuse.
    """
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    if len(text) > GENERATE_MAX_CHARS:
        raise HTTPException(status_code=400, detail="Text too long")
    if not store.is_paid_and_unused(req.session_id):
        raise HTTPException(
            status_code=402, detail="Payment required or already used"
        )
    # Generate audio
    audio = synth(text, req.voice, speaking_rate=req.rate)
    # Save to disk
    fname = _hash_name("paid", f"{time.time()}|{req.session_id}|{req.voice}")
    fname.write_bytes(audio)
    # Mark as used
    store.mark_used(req.session_id)
    return {"download": f"/api/file/{fname.name}"}
