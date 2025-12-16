#!/usr/bin/env python3
# premium_api.py — Stripe utilities with preview/generation disabled

"""FastAPI application for premium checkout utilities.

Premium text-to-speech endpoints have been disabled to avoid sending
user text to external services. The API still exposes Stripe checkout
helpers and a placeholder voice listing for compatibility.
"""

import os
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Body
from pydantic import BaseModel

from .providers import list_public_voices
from . import store


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

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://read-aloud.com",
        "https://ndaly111.github.io",  # GH Pages fallback
        "http://localhost:5500",       # local static test
        "http://127.0.0.1:5500",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


 

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
    """Placeholder preview endpoint with TTS disabled."""

    _ = (voice, text, rate)
    raise HTTPException(
        status_code=503,
        detail="Voice previews are currently disabled and no audio is generated.",
    )


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
    """Placeholder generation endpoint with premium TTS disabled."""

    _ = req
    raise HTTPException(
        status_code=503,
        detail="Premium text-to-speech generation is disabled; no audio is produced.",
    )
