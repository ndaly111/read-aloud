#!/usr/bin/env python3
"""
Read-Aloud premium billing + licensing (Phase 1).

Self-contained, ENV-GATED module. It does NOTHING unless the required Stripe +
license-DB env vars are set, so importing it on the live server is a no-op until
you deliberately configure it. The existing free /api/tts path is never touched.

What it provides (Phase 1 — the payment -> license-key -> entitlement loop):
  POST /api/billing/checkout   -> create a Stripe Checkout session, return its URL
  POST /api/billing/webhook    -> Stripe webhook: on paid/updated/canceled subs,
                                  mint/update/disable a license key
  GET  /api/billing/status     -> look up a license by ?key= or ?session_id=,
                                  return plan, char cap, char used, status

Phase 2 will add the metered premium TTS endpoint that calls consume_chars()
before generating ElevenLabs audio. The helpers are already here.

Required env vars (all must be set for billing to activate):
  STRIPE_SECRET_KEY        sk_test_... (test) or sk_live_...
  STRIPE_WEBHOOK_SECRET    whsec_...  (from the Stripe webhook endpoint)
  LICENSE_DB               path to a writeable sqlite file on the mini PC
  STRIPE_TIERS_JSON        JSON mapping Stripe price IDs -> {plan, cap}, e.g.
                           {"price_abc":{"plan":"basic","cap":25000},
                            "price_def":{"plan":"pro","cap":60000}}
  SITE_URL                 e.g. https://read-aloud.com  (for success/cancel redirects)
"""
import json
import os
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

STRIPE_SECRET = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET")
LICENSE_DB = os.environ.get("LICENSE_DB")
SITE_URL = os.environ.get("SITE_URL", "https://read-aloud.com").rstrip("/")

try:
    TIERS = json.loads(os.environ.get("STRIPE_TIERS_JSON", "{}"))
except Exception:
    TIERS = {}

# Billing only activates when Stripe + DB are fully configured.
BILLING_ENABLED = bool(STRIPE_SECRET and STRIPE_WEBHOOK_SECRET and LICENSE_DB and TIERS)

router = APIRouter()
_db_lock = Lock()

# Lazily imported so the module imports cleanly even if `stripe` isn't installed
_stripe = None


def _get_stripe():
    global _stripe
    if _stripe is None:
        import stripe as _s
        _s.api_key = STRIPE_SECRET
        _stripe = _s
    return _stripe


# ----------------------------------------------------------------------
# License store (SQLite)
# ----------------------------------------------------------------------
def init_db() -> None:
    if not LICENSE_DB:
        return
    conn = sqlite3.connect(LICENSE_DB, timeout=5)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS licenses ("
            "  key TEXT PRIMARY KEY,"
            "  stripe_customer TEXT,"
            "  stripe_sub TEXT,"
            "  checkout_session TEXT,"
            "  email TEXT,"
            "  plan TEXT NOT NULL,"
            "  char_cap INTEGER NOT NULL,"
            "  char_used INTEGER NOT NULL DEFAULT 0,"
            "  period_start TEXT NOT NULL,"
            "  status TEXT NOT NULL,"          # active | canceled | past_due
            "  created_at TEXT NOT NULL,"
            "  updated_at TEXT NOT NULL)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_lic_sub ON licenses(stripe_sub)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_lic_session ON licenses(checkout_session)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_lic_customer ON licenses(stripe_customer)")
        conn.commit()
    finally:
        conn.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _conn():
    c = sqlite3.connect(LICENSE_DB, timeout=5)
    c.execute("PRAGMA busy_timeout=4000")
    c.row_factory = sqlite3.Row
    return c


def mint_key() -> str:
    """Opaque, URL-safe license key. 'ra_' prefix for easy identification."""
    return "ra_" + secrets.token_urlsafe(24)


def get_license(key: str) -> Optional[dict]:
    if not LICENSE_DB or not key:
        return None
    with _db_lock:
        c = _conn()
        try:
            row = c.execute("SELECT * FROM licenses WHERE key=?", (key,)).fetchone()
            return dict(row) if row else None
        finally:
            c.close()


def get_license_by_session(session_id: str) -> Optional[dict]:
    if not LICENSE_DB or not session_id:
        return None
    with _db_lock:
        c = _conn()
        try:
            row = c.execute(
                "SELECT * FROM licenses WHERE checkout_session=?", (session_id,)
            ).fetchone()
            return dict(row) if row else None
        finally:
            c.close()


def upsert_license_for_sub(stripe_sub: str, *, stripe_customer: str, plan: str,
                           char_cap: int, status: str, email: Optional[str],
                           checkout_session: Optional[str]) -> str:
    """Create a license for a subscription, or update the existing one.
    Returns the license key. Idempotent on stripe_sub."""
    with _db_lock:
        c = _conn()
        try:
            existing = c.execute(
                "SELECT key FROM licenses WHERE stripe_sub=?", (stripe_sub,)
            ).fetchone()
            now = _now()
            if existing:
                key = existing["key"]
                c.execute(
                    "UPDATE licenses SET plan=?, char_cap=?, status=?, "
                    "stripe_customer=COALESCE(?, stripe_customer), "
                    "email=COALESCE(?, email), "
                    "checkout_session=COALESCE(?, checkout_session), "
                    "updated_at=? WHERE key=?",
                    (plan, char_cap, status, stripe_customer, email,
                     checkout_session, now, key),
                )
            else:
                key = mint_key()
                c.execute(
                    "INSERT INTO licenses (key, stripe_customer, stripe_sub, "
                    "checkout_session, email, plan, char_cap, char_used, "
                    "period_start, status, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,0,?,?,?,?)",
                    (key, stripe_customer, stripe_sub, checkout_session, email,
                     plan, char_cap, now, status, now, now),
                )
            c.commit()
            return key
        finally:
            c.close()


def set_status_for_sub(stripe_sub: str, status: str) -> None:
    with _db_lock:
        c = _conn()
        try:
            c.execute(
                "UPDATE licenses SET status=?, updated_at=? WHERE stripe_sub=?",
                (status, _now(), stripe_sub),
            )
            c.commit()
        finally:
            c.close()


def consume_chars(key: str, n: int) -> tuple:
    """Phase 2 helper. Atomically check + decrement remaining quota.
    Resets char_used at the start of a new monthly period.
    Returns (ok: bool, remaining: int, reason: str)."""
    if not LICENSE_DB:
        return (False, 0, "billing_disabled")
    with _db_lock:
        c = _conn()
        try:
            row = c.execute("SELECT * FROM licenses WHERE key=?", (key,)).fetchone()
            if not row:
                return (False, 0, "no_such_key")
            lic = dict(row)
            if lic["status"] != "active":
                return (False, 0, f"status_{lic['status']}")
            # Monthly period reset
            try:
                ps = datetime.fromisoformat(lic["period_start"])
            except Exception:
                ps = datetime.now(timezone.utc)
            now = datetime.now(timezone.utc)
            used = lic["char_used"]
            period_start = lic["period_start"]
            if (now - ps).days >= 30:
                used = 0
                period_start = _now()
            if used + n > lic["char_cap"]:
                # update reset state even on rejection
                c.execute(
                    "UPDATE licenses SET char_used=?, period_start=?, updated_at=? WHERE key=?",
                    (used, period_start, _now(), key),
                )
                c.commit()
                return (False, max(0, lic["char_cap"] - used), "cap_reached")
            used += n
            c.execute(
                "UPDATE licenses SET char_used=?, period_start=?, updated_at=? WHERE key=?",
                (used, period_start, _now(), key),
            )
            c.commit()
            return (True, lic["char_cap"] - used, "ok")
        finally:
            c.close()


# ----------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------
@router.post("/api/billing/checkout")
async def create_checkout(request: Request):
    """Body: {"price_id": "price_..."}. Returns {"url": "https://checkout.stripe.com/..."}."""
    if not BILLING_ENABLED:
        raise HTTPException(status_code=404, detail="billing not enabled")
    body = await request.json()
    price_id = body.get("price_id")
    if price_id not in TIERS:
        raise HTTPException(status_code=400, detail="unknown price_id")
    stripe = _get_stripe()
    try:
        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=f"{SITE_URL}/premium-success.html?session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{SITE_URL}/?checkout=cancelled",
            allow_promotion_codes=True,
        )
        return {"url": session.url}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"stripe checkout failed: {e}")


def _provision_subscription(stripe, sub_id, *, customer, email, checkout_session):
    """Re-retrieve the subscription (canonical shape) and mint/update its license.
    Defensive against payload/expansion differences across Stripe API versions."""
    if not sub_id:
        return
    sub = stripe.Subscription.retrieve(sub_id)
    items = (sub.get("items") or {}).get("data") or []
    if not items:
        print(f"[billing] sub {sub_id} has no line items")
        return
    price = items[0].get("price")
    price_id = price.get("id") if isinstance(price, dict) else price
    tier = TIERS.get(price_id)
    if not tier:
        print(f"[billing] no tier configured for price {price_id}")
        return
    status = sub.get("status")
    mapped = "active" if status in ("active", "trialing") else \
             ("past_due" if status == "past_due" else "canceled")
    key = upsert_license_for_sub(
        sub_id, stripe_customer=customer or sub.get("customer"),
        plan=tier["plan"], char_cap=int(tier["cap"]),
        status=mapped, email=email, checkout_session=checkout_session,
    )
    print(f"[billing] provisioned license {key} sub={sub_id} plan={tier['plan']} status={mapped}")


@router.post("/api/billing/webhook")
async def stripe_webhook(request: Request):
    """Stripe webhook. Verifies signature, then provisions/updates/disables licenses."""
    if not BILLING_ENABLED:
        raise HTTPException(status_code=404, detail="billing not enabled")
    stripe = _get_stripe()
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"signature verification failed: {e}")

    etype = event["type"]
    obj = event["data"]["object"]

    try:
        if etype == "checkout.session.completed":
            _provision_subscription(
                stripe, obj.get("subscription"),
                customer=obj.get("customer"),
                email=(obj.get("customer_details") or {}).get("email"),
                checkout_session=obj.get("id"),
            )

        elif etype in ("customer.subscription.updated", "customer.subscription.created"):
            _provision_subscription(
                stripe, obj.get("id"),
                customer=obj.get("customer"),
                email=None, checkout_session=None,
            )

        elif etype == "customer.subscription.deleted":
            set_status_for_sub(obj.get("id"), "canceled")

    except Exception as e:
        # Log full traceback but still 200 so Stripe doesn't hammer retries.
        import traceback
        print(f"[billing] webhook handler error on {etype}: {e}\n{traceback.format_exc()}")

    return {"received": True}


@router.get("/api/billing/status")
async def billing_status(key: Optional[str] = None, session_id: Optional[str] = None):
    """Look up a license by key or by Stripe checkout session_id (used by the
    success page to hand the freshly-minted key to the buyer)."""
    if not BILLING_ENABLED:
        raise HTTPException(status_code=404, detail="billing not enabled")
    lic = get_license(key) if key else (get_license_by_session(session_id) if session_id else None)
    if not lic:
        raise HTTPException(status_code=404, detail="license not found")
    return {
        "key": lic["key"],
        "plan": lic["plan"],
        "status": lic["status"],
        "char_cap": lic["char_cap"],
        "char_used": lic["char_used"],
        "char_remaining": max(0, lic["char_cap"] - lic["char_used"]),
        "period_start": lic["period_start"],
    }


# Initialize the DB at import time if billing is configured
if BILLING_ENABLED:
    try:
        init_db()
        print("[billing] enabled — license DB ready")
    except Exception as _e:
        print(f"[billing] init failed, disabling: {_e}")
        BILLING_ENABLED = False
else:
    print("[billing] disabled (Stripe/DB env not fully set) — no-op")
