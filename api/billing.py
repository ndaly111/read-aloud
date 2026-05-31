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
import io
import json
import os
import secrets
import smtplib
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from threading import Lock
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

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

# Transactional email (license-key delivery + recovery). Plain SMTP so it works
# with Resend / SendGrid / Gmail / any relay. Inert unless SMTP_HOST + SMTP_FROM set.
SMTP_HOST = os.environ.get("SMTP_HOST")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASS = os.environ.get("SMTP_PASS")
SMTP_FROM = os.environ.get("SMTP_FROM", "Read-Aloud <noreply@read-aloud.com>")
EMAIL_ENABLED = bool(SMTP_HOST and SMTP_FROM)

# Premium TTS (ElevenLabs) — only activates when the API key is set AND billing is on.
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")
# Circuit breaker: hard ceiling on total premium characters generated per UTC day,
# across ALL users. Protects against a bug/abuse running up an unbounded ElevenLabs bill.
PREMIUM_DAILY_CHAR_CAP = int(os.environ.get("PREMIUM_DAILY_CHAR_CAP", "500000"))
PREMIUM_MAX_CHARS_PER_REQUEST = int(os.environ.get("PREMIUM_MAX_CHARS_PER_REQUEST", "5000"))
PREMIUM_TTS_ENABLED = bool(BILLING_ENABLED and ELEVENLABS_API_KEY)

router = APIRouter()
_db_lock = Lock()

# Cache of public pricing (price amounts fetched from Stripe), refreshed hourly.
_tiers_cache = {"data": None, "ts": 0.0}

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
        # Global daily premium-char counter (circuit breaker against runaway cost)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS premium_daily ("
            "  day TEXT PRIMARY KEY,"
            "  chars INTEGER NOT NULL DEFAULT 0)"
        )
        # Migration: flag so the welcome/key email is sent at most once per license.
        cols = [r[1] for r in conn.execute("PRAGMA table_info(licenses)").fetchall()]
        if "welcome_emailed" not in cols:
            conn.execute("ALTER TABLE licenses ADD COLUMN welcome_emailed INTEGER NOT NULL DEFAULT 0")
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


def refund_chars(key: str, n: int) -> None:
    """Return n characters to a license (used when an ElevenLabs call fails after
    we've already debited the quota). Floors char_used at 0."""
    if not LICENSE_DB or n <= 0:
        return
    with _db_lock:
        c = _conn()
        try:
            c.execute(
                "UPDATE licenses SET char_used = MAX(0, char_used - ?), updated_at=? WHERE key=?",
                (n, _now(), key),
            )
            c.commit()
        finally:
            c.close()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def daily_spend_check_and_add(n: int) -> tuple:
    """Circuit breaker. Atomically check today's global premium-char total against
    PREMIUM_DAILY_CHAR_CAP and add n if under. Returns (ok, today_total)."""
    if not LICENSE_DB:
        return (False, 0)
    with _db_lock:
        c = _conn()
        try:
            day = _today()
            row = c.execute("SELECT chars FROM premium_daily WHERE day=?", (day,)).fetchone()
            cur_total = row["chars"] if row else 0
            if cur_total + n > PREMIUM_DAILY_CHAR_CAP:
                return (False, cur_total)
            c.execute(
                "INSERT INTO premium_daily (day, chars) VALUES (?, ?) "
                "ON CONFLICT(day) DO UPDATE SET chars = chars + ?",
                (day, n, n),
            )
            c.commit()
            return (True, cur_total + n)
        finally:
            c.close()


def daily_spend_refund(n: int) -> None:
    if not LICENSE_DB or n <= 0:
        return
    with _db_lock:
        c = _conn()
        try:
            c.execute(
                "UPDATE premium_daily SET chars = MAX(0, chars - ?) WHERE day=?",
                (n, _today()),
            )
            c.commit()
        finally:
            c.close()


def _elevenlabs_tts(text: str, voice_id: str) -> bytes:
    """Call ElevenLabs TTS. Returns mp3 bytes or raises. Key stays server-side."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    payload = json.dumps({
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


# ----------------------------------------------------------------------
# Transactional email (license delivery + recovery)
# ----------------------------------------------------------------------
def get_active_license_by_email(email: str) -> Optional[dict]:
    if not LICENSE_DB or not email:
        return None
    with _db_lock:
        c = _conn()
        try:
            row = c.execute(
                "SELECT * FROM licenses WHERE lower(email)=lower(?) AND status='active' "
                "ORDER BY updated_at DESC LIMIT 1",
                (email,),
            ).fetchone()
            return dict(row) if row else None
        finally:
            c.close()


def mark_welcome_emailed(key: str) -> None:
    if not LICENSE_DB:
        return
    with _db_lock:
        c = _conn()
        try:
            c.execute("UPDATE licenses SET welcome_emailed=1, updated_at=? WHERE key=?",
                      (_now(), key))
            c.commit()
        finally:
            c.close()


def _send_email(to_addr: str, subject: str, text_body: str, html_body: Optional[str] = None) -> bool:
    """Blocking SMTP send. Call via run_in_threadpool from async endpoints."""
    if not EMAIL_ENABLED or not to_addr:
        return False
    msg = EmailMessage()
    msg["From"] = SMTP_FROM
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(text_body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")
    try:
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20) as s:
                if SMTP_USER:
                    s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
                s.ehlo(); s.starttls(); s.ehlo()
                if SMTP_USER:
                    s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        return True
    except Exception as e:
        print(f"[billing] email send failed to {to_addr}: {e}")
        return False


def _send_license_email(email: str, key: str, plan: str, cap: int) -> bool:
    subject = "Your Read-Aloud Studio license key"
    text = (
        f"Thanks for subscribing to Read-Aloud Studio ({plan}).\n\n"
        f"Your license key:\n{key}\n\n"
        f"It's already active in the browser you bought it on. To use Studio voices on "
        f"another device, go to {SITE_URL}, open \"Unlock Studio voices\", and paste this key.\n\n"
        f"Keep this email — it's how you recover your key.\n\n"
        f"Plan: {plan} - {cap:,} characters per month\n"
    )
    html = (
        f'<div style="font-family:Georgia,serif;color:#1a1c22;max-width:520px;line-height:1.5">'
        f'<h2 style="color:#c8341e;margin:0 0 12px">You\'re in. Thank you.</h2>'
        f'<p>Thanks for subscribing to <strong>Read-Aloud Studio</strong> ({plan}).</p>'
        f'<p style="margin:18px 0 6px">Your license key:</p>'
        f'<p style="font-family:monospace;font-size:15px;background:#faf4e6;border:1px solid #1a1c22;'
        f'padding:12px;word-break:break-all">{key}</p>'
        f'<p>It\'s already active in the browser you bought it on. To use Studio voices on another '
        f'device, go to <a href="{SITE_URL}">{SITE_URL}</a>, open <em>Unlock Studio voices</em>, '
        f'and paste this key.</p>'
        f'<p style="color:#6f6857;font-size:14px">Keep this email — it\'s how you recover your key.<br>'
        f'Plan: {plan} &middot; {cap:,} characters per month.</p></div>'
    )
    return _send_email(email, subject, text, html)


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


def _sg(obj, key, default=None):
    """Safe field access for Stripe objects. stripe>=15 StripeObjects do NOT
    implement .get(), and missing-key subscript raises KeyError, so we guard."""
    try:
        val = obj[key]
    except (KeyError, TypeError, AttributeError):
        return default
    return val if val is not None else default


def _provision_subscription(stripe, sub_id, *, customer, email, checkout_session):
    """Re-retrieve the subscription (canonical shape) and mint/update its license.
    Uses _sg() everywhere because Stripe objects lack .get() in stripe>=15.
    Returns the license key (or None)."""
    if not sub_id:
        return None
    sub = stripe.Subscription.retrieve(sub_id)
    items_obj = _sg(sub, "items")
    data = _sg(items_obj, "data") if items_obj is not None else None
    if not data:
        print(f"[billing] sub {sub_id} has no line items")
        return None
    price = _sg(data[0], "price")
    price_id = price if isinstance(price, str) else _sg(price, "id")
    tier = TIERS.get(price_id)  # TIERS is a plain dict — .get is fine
    if not tier:
        print(f"[billing] no tier configured for price {price_id}")
        return None
    status = _sg(sub, "status")
    mapped = "active" if status in ("active", "trialing") else \
             ("past_due" if status == "past_due" else "canceled")
    key = upsert_license_for_sub(
        sub_id, stripe_customer=customer or _sg(sub, "customer"),
        plan=tier["plan"], char_cap=int(tier["cap"]),
        status=mapped, email=email, checkout_session=checkout_session,
    )
    print(f"[billing] provisioned license {key} sub={sub_id} plan={tier['plan']} status={mapped}")
    return key


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
            email = _sg(_sg(obj, "customer_details") or {}, "email")
            key = _provision_subscription(
                stripe, _sg(obj, "subscription"),
                customer=_sg(obj, "customer"),
                email=email,
                checkout_session=_sg(obj, "id"),
            )
            if key and email:
                lic = get_license(key)
                if lic and not lic.get("welcome_emailed"):
                    sent = await run_in_threadpool(
                        _send_license_email, email, key, lic["plan"], lic["char_cap"])
                    if sent:
                        mark_welcome_emailed(key)

        elif etype in ("customer.subscription.updated", "customer.subscription.created"):
            _provision_subscription(
                stripe, _sg(obj, "id"),
                customer=_sg(obj, "customer"),
                email=None, checkout_session=None,
            )

        elif etype == "customer.subscription.deleted":
            set_status_for_sub(_sg(obj, "id"), "canceled")

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


_recover_guard = {}  # email -> last-send epoch; light in-memory spam guard


@router.post("/api/billing/recover")
async def recover_key(request: Request):
    """Email a buyer their license key. Always returns the same generic message so
    it can't be used to probe which emails have a subscription."""
    if not BILLING_ENABLED:
        raise HTTPException(status_code=404, detail="billing not enabled")
    body = await request.json()
    email = (body.get("email") or "").strip()
    generic = {"ok": True,
               "message": "If that email has an active subscription, the key is on its way."}
    if not email or "@" not in email:
        return generic
    if not EMAIL_ENABLED:
        return {"ok": False, "message": "Email delivery isn't set up yet — contact admin@read-aloud.com."}
    now = time.time()
    if len(_recover_guard) > 2000:  # bound memory
        for k in [k for k, t in _recover_guard.items() if now - t > 3600]:
            _recover_guard.pop(k, None)
    if now - _recover_guard.get(email.lower(), 0) < 60:
        return generic  # rate-limit repeated requests for the same email
    _recover_guard[email.lower()] = now
    lic = get_active_license_by_email(email)
    if lic:
        await run_in_threadpool(_send_license_email, email, lic["key"], lic["plan"], lic["char_cap"])
    return generic


@router.get("/api/billing/tiers")
async def billing_tiers():
    """Public pricing for the frontend upgrade UI. Caps come from STRIPE_TIERS_JSON;
    amounts are pulled live from Stripe (cached 1h). The frontend renders prices from
    this, so flipping test->live mode needs no frontend change — just new env."""
    if not BILLING_ENABLED:
        raise HTTPException(status_code=404, detail="billing not enabled")
    now = time.time()
    if _tiers_cache["data"] is not None and now - _tiers_cache["ts"] < 3600:
        return _tiers_cache["data"]
    stripe = _get_stripe()
    out = []
    for price_id, tier in TIERS.items():
        amount, currency, interval = None, "usd", "month"
        try:
            p = stripe.Price.retrieve(price_id)
            amount = _sg(p, "unit_amount")
            currency = _sg(p, "currency", "usd")
            rec = _sg(p, "recurring")
            if rec is not None:
                interval = _sg(rec, "interval", "month")
        except Exception as e:
            print(f"[billing] tiers: could not retrieve price {price_id}: {e}")
        out.append({
            "price_id": price_id,
            "plan": tier.get("plan"),
            "cap": int(tier.get("cap", 0)),
            "amount_cents": amount,
            "currency": currency,
            "interval": interval,
        })
    out.sort(key=lambda t: (t["amount_cents"] is None, t["amount_cents"] or 0))
    payload = {"tiers": out}
    _tiers_cache["data"] = payload
    _tiers_cache["ts"] = now
    return payload


# ----------------------------------------------------------------------
# Premium TTS (ElevenLabs) — Phase 2
# ----------------------------------------------------------------------
from fastapi.responses import StreamingResponse


@router.get("/api/tts/premium/voices")
async def premium_voices():
    """Proxy ElevenLabs' voice list so the frontend can populate the premium selector.
    Key stays server-side."""
    if not PREMIUM_TTS_ENABLED:
        raise HTTPException(status_code=404, detail="premium tts not enabled")
    try:
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": ELEVENLABS_API_KEY},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        voices = [
            {"id": v.get("voice_id"), "name": v.get("name"),
             "labels": v.get("labels", {})}
            for v in data.get("voices", [])
        ]
        return {"voices": voices}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"could not fetch voices: {e}")


@router.post("/api/tts/premium")
async def premium_tts(request: Request):
    """Body: {"text","voice_id","license_key"}. Validates the license + quota +
    daily circuit breaker, then streams ElevenLabs audio. Charges the license by
    character count; refunds on generation failure so failed calls aren't billed."""
    if not PREMIUM_TTS_ENABLED:
        raise HTTPException(status_code=404, detail="premium tts not enabled")

    body = await request.json()
    text = (body.get("text") or "").strip()
    voice_id = body.get("voice_id") or ""
    key = body.get("license_key") or ""

    if not text:
        raise HTTPException(status_code=400, detail="text required")
    if not voice_id:
        raise HTTPException(status_code=400, detail="voice_id required")
    if not key:
        raise HTTPException(status_code=401, detail="license_key required")
    n = len(text)
    if n > PREMIUM_MAX_CHARS_PER_REQUEST:
        raise HTTPException(status_code=413,
                            detail=f"text too long ({n}); max {PREMIUM_MAX_CHARS_PER_REQUEST} per request")

    # 1) Global daily circuit breaker (protects against runaway cost)
    ok_day, _total = daily_spend_check_and_add(n)
    if not ok_day:
        raise HTTPException(status_code=503,
                            detail="premium temporarily unavailable (daily capacity reached)")

    # 2) Per-license quota (atomic debit)
    ok, remaining, reason = consume_chars(key, n)
    if not ok:
        daily_spend_refund(n)  # undo the daily add — we're not generating
        if reason == "no_such_key":
            raise HTTPException(status_code=401, detail="invalid license key")
        if reason == "cap_reached":
            raise HTTPException(status_code=402, detail="monthly character limit reached — upgrade or wait for renewal")
        raise HTTPException(status_code=403, detail=f"license not active ({reason})")

    # 3) Generate. On failure, refund both counters so the user isn't charged.
    try:
        audio = _elevenlabs_tts(text, voice_id)
    except urllib.error.HTTPError as e:
        refund_chars(key, n); daily_spend_refund(n)
        raise HTTPException(status_code=502, detail=f"elevenlabs error {e.code}")
    except Exception as e:
        refund_chars(key, n); daily_spend_refund(n)
        raise HTTPException(status_code=502, detail=f"premium generation failed: {e}")

    if not audio or len(audio) < 100:
        refund_chars(key, n); daily_spend_refund(n)
        raise HTTPException(status_code=502, detail="empty audio from provider")

    return StreamingResponse(
        io.BytesIO(audio),
        media_type="audio/mpeg",
        headers={"Content-Disposition": "inline",
                 "X-Chars-Remaining": str(remaining)},
    )


# Initialize the DB at import time if billing is configured
if BILLING_ENABLED:
    try:
        init_db()
        print("[billing] enabled — license DB ready")
        print(f"[billing] email delivery {'enabled (' + str(SMTP_HOST) + ')' if EMAIL_ENABLED else 'disabled (set SMTP_HOST/SMTP_FROM)'}")
        if PREMIUM_TTS_ENABLED:
            print(f"[billing] premium TTS enabled (ElevenLabs model={ELEVENLABS_MODEL}, "
                  f"daily cap={PREMIUM_DAILY_CHAR_CAP:,} chars)")
        else:
            print("[billing] premium TTS disabled (set ELEVENLABS_API_KEY to enable)")
    except Exception as _e:
        print(f"[billing] init failed, disabling: {_e}")
        BILLING_ENABLED = False
else:
    print("[billing] disabled (Stripe/DB env not fully set) — no-op")
