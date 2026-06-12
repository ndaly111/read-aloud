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

# ElevenLabs monthly plan fees (cents), by tier name, for the cost side of the P&L.
ELEVENLABS_PLAN_FEES = {
    "free": 0, "starter": 500, "creator": 2200, "independent_publisher": 2200,
    "pro": 9900, "growing_business": 33000, "scale": 33000, "business": 132000,
}

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
REPLY_TO = os.environ.get("SUPPORT_EMAIL", "admin@read-aloud.com")
EMAIL_ENABLED = bool(SMTP_HOST and SMTP_FROM)

# Premium TTS (ElevenLabs) — only activates when the API key is set AND billing is on.
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")
# Circuit breaker: hard ceiling on total premium characters generated per UTC day,
# across ALL users. Protects against a bug/abuse running up an unbounded ElevenLabs bill.
PREMIUM_DAILY_CHAR_CAP = int(os.environ.get("PREMIUM_DAILY_CHAR_CAP", "500000"))
# Manual override for the ElevenLabs monthly plan fee (cents), used on the P&L when
# the API key can't read /v1/user/subscription. e.g. 2200 = Creator ($22/mo).
ELEVENLABS_PLAN_FEE_CENTS = int(os.environ.get("ELEVENLABS_PLAN_FEE_CENTS", "0"))
# Marginal ElevenLabs cost per 1,000 characters (cents), for estimating the $ cost
# of each usage category on the P&L. ~20 = $0.20/1k (Creator/Pro-ish).
ELEVENLABS_COST_PER_1K_CENTS = float(os.environ.get("ELEVENLABS_COST_PER_1K_CENTS", "20"))
PREMIUM_MAX_CHARS_PER_REQUEST = int(os.environ.get("PREMIUM_MAX_CHARS_PER_REQUEST", "5000"))
# Free personalized trial: unlicensed visitors hear the first N chars of THEIR text
# in a Studio voice, once. Bounded by per-IP cooldown + a global daily char cap.
PREMIUM_TRIAL_MAX_CHARS = int(os.environ.get("PREMIUM_TRIAL_MAX_CHARS", "220"))
PREMIUM_TRIAL_DAILY_CAP = int(os.environ.get("PREMIUM_TRIAL_DAILY_CAP", "30000"))
PREMIUM_TRIAL_IP_COOLDOWN = int(os.environ.get("PREMIUM_TRIAL_IP_COOLDOWN", "72000"))  # ~20h
# Personalized "read your own text" trial is OFF by default — it generates real
# characters per visitor and can burn the ElevenLabs quota fast. Free previews use
# the cached canned samples instead (zero ongoing cost). Set to "1" to re-enable.
PREMIUM_TRIAL_ENABLED = os.environ.get("PREMIUM_TRIAL_ENABLED", "0") == "1"
PREMIUM_TTS_ENABLED = bool(BILLING_ENABLED and ELEVENLABS_API_KEY)

router = APIRouter()
_db_lock = Lock()

# Cache of public pricing (price amounts fetched from Stripe), refreshed hourly.
_tiers_cache = {"data": None, "ts": 0.0}

# Per-IP cooldown for the free personalized trial (in-memory; bounded on use).
_trial_ip_guard = {}

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
        # Studio engagement funnel counters (one row per day per event name).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            "  day TEXT NOT NULL,"
            "  name TEXT NOT NULL,"
            "  count INTEGER NOT NULL DEFAULT 0,"
            "  PRIMARY KEY (day, name))"
        )
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


def daily_trial_check_and_add(n: int) -> tuple:
    """Separate daily budget for free trials (keyed 'trial:<day>') so a flood of
    trials can't exhaust the paying-customer cost ceiling. Returns (ok, total)."""
    if not LICENSE_DB:
        return (False, 0)
    with _db_lock:
        c = _conn()
        try:
            day = "trial:" + _today()
            row = c.execute("SELECT chars FROM premium_daily WHERE day=?", (day,)).fetchone()
            cur = row["chars"] if row else 0
            if cur + n > PREMIUM_TRIAL_DAILY_CAP:
                return (False, cur)
            c.execute(
                "INSERT INTO premium_daily (day, chars) VALUES (?, ?) "
                "ON CONFLICT(day) DO UPDATE SET chars = chars + ?",
                (day, n, n),
            )
            c.commit()
            return (True, cur + n)
        finally:
            c.close()


def daily_trial_refund(n: int) -> None:
    if not LICENSE_DB or n <= 0:
        return
    with _db_lock:
        c = _conn()
        try:
            c.execute(
                "UPDATE premium_daily SET chars = MAX(0, chars - ?) WHERE day=?",
                (n, "trial:" + _today()),
            )
            c.commit()
        finally:
            c.close()


def bump_event(name: str, n: int = 1) -> None:
    """Increment a Studio-funnel event counter for today."""
    if not LICENSE_DB or not name:
        return
    with _db_lock:
        c = _conn()
        try:
            c.execute(
                "INSERT INTO events (day, name, count) VALUES (?,?,?) "
                "ON CONFLICT(day, name) DO UPDATE SET count = count + ?",
                (_today(), name, n, n),
            )
            c.commit()
        finally:
            c.close()


def events_summary(names) -> dict:
    """Return {name: {today, all}} for the given event names."""
    out = {n: {"today": 0, "all": 0} for n in names}
    if not LICENSE_DB:
        return out
    with _db_lock:
        c = _conn()
        try:
            for r in c.execute("SELECT name, SUM(count) total FROM events GROUP BY name"):
                if r["name"] in out:
                    out[r["name"]]["all"] = r["total"] or 0
            for r in c.execute("SELECT name, count FROM events WHERE day=?", (_today(),)):
                if r["name"] in out:
                    out[r["name"]]["today"] = r["count"] or 0
            return out
        finally:
            c.close()


def daily_counter_add(prefix: str, n: int) -> None:
    """Increment an arbitrary daily counter in premium_daily (e.g. 'sample:').
    Tracking only — no cap."""
    if not LICENSE_DB or n <= 0:
        return
    with _db_lock:
        c = _conn()
        try:
            day = prefix + _today()
            c.execute(
                "INSERT INTO premium_daily (day, chars) VALUES (?, ?) "
                "ON CONFLICT(day) DO UPDATE SET chars = chars + ?",
                (day, n, n),
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
    if REPLY_TO:
        msg["Reply-To"] = REPLY_TO
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
from fastapi.responses import FileResponse, StreamingResponse

# Free preview samples: one short fixed clip per voice, generated once and cached
# to disk. Lets unlicensed visitors hear a Studio voice before paying. Bounded
# cost: ~(#voices x sample length) one time, then zero — never per-play.
# Expressive script on purpose: flat product copy is exactly what free Edge
# voices render well, hiding ElevenLabs' real advantage (emotion, pacing,
# delivery). Changed 2026-06-11 after a flat sample made Studio sound
# identical to the free tier.
PREMIUM_SAMPLE_TEXT = os.environ.get(
    "PREMIUM_SAMPLE_TEXT",
    "The letter arrived on a Tuesday, of all days. She read it twice, laughed "
    "once, and cried a little anyway. \"Well,\" she whispered, \"it's about "
    "time.\" Some voices can carry a whole story. This is one of them.")
PREMIUM_SAMPLE_DIR = os.environ.get("PREMIUM_SAMPLE_DIR", "/home/ubuntu/read-aloud/samples")

_voices_cache = {"data": None, "ids": set(), "ts": 0.0}


def _fetch_voices():
    """Blocking. Returns the ElevenLabs voice list (cached 1h) and caches the id set."""
    now = time.time()
    if _voices_cache["data"] is not None and now - _voices_cache["ts"] < 3600:
        return _voices_cache["data"]
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/voices",
        headers={"xi-api-key": ELEVENLABS_API_KEY},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    voices = [
        {"id": v.get("voice_id"), "name": v.get("name"), "labels": v.get("labels", {})}
        for v in data.get("voices", [])
    ]
    _voices_cache["data"] = voices
    _voices_cache["ids"] = {v["id"] for v in voices if v["id"]}
    _voices_cache["ts"] = now
    return voices


@router.get("/api/tts/premium/voices")
async def premium_voices():
    """Public voice list for the Studio selector. Key stays server-side."""
    if not PREMIUM_TTS_ENABLED:
        raise HTTPException(status_code=404, detail="premium tts not enabled")
    try:
        voices = await run_in_threadpool(_fetch_voices)
        return {"voices": voices}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"could not fetch voices: {e}")


@router.get("/api/tts/premium/sample")
async def premium_sample(voice_id: str):
    """Free, cached preview clip for one voice. Generated once on first request
    (validated against the real voice list so generation is bounded), then served
    from disk forever — no per-play cost, no license required."""
    if not PREMIUM_TTS_ENABLED:
        raise HTTPException(status_code=404, detail="premium tts not enabled")
    if not voice_id:
        raise HTTPException(status_code=400, detail="voice_id required")
    try:
        await run_in_threadpool(_fetch_voices)
    except Exception:
        pass
    if _voices_cache["ids"] and voice_id not in _voices_cache["ids"]:
        raise HTTPException(status_code=400, detail="unknown voice")
    bump_event("sample_play")  # counts every preview play, cached or not
    safe = voice_id.replace("/", "").replace("..", "").replace("\\", "")
    path = os.path.join(PREMIUM_SAMPLE_DIR, f"{safe}.mp3")
    if not os.path.exists(path):
        try:
            audio = await run_in_threadpool(_elevenlabs_tts, PREMIUM_SAMPLE_TEXT, voice_id)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"sample generation failed: {e}")
        if not audio or len(audio) < 100:
            raise HTTPException(status_code=502, detail="empty sample from provider")
        os.makedirs(PREMIUM_SAMPLE_DIR, exist_ok=True)
        with open(path, "wb") as f:
            f.write(audio)
        daily_counter_add("sample:", len(PREMIUM_SAMPLE_TEXT))
        print(f"[billing] generated preview sample for voice {voice_id} ({len(audio)} bytes)")
    return FileResponse(path, media_type="audio/mpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@router.post("/api/tts/premium/trial")
async def premium_trial(request: Request):
    """One free, personalized Studio preview: the first ~220 chars of the visitor's
    OWN text, no license. Throttled per-IP (~once/day) and capped by a separate
    daily char budget so it can never run up an unbounded bill."""
    if not PREMIUM_TTS_ENABLED or not PREMIUM_TRIAL_ENABLED:
        raise HTTPException(status_code=404, detail="trial not enabled")
    body = await request.json()
    text = (body.get("text") or "").strip()
    voice_id = body.get("voice_id") or ""
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    if not voice_id:
        raise HTTPException(status_code=400, detail="voice_id required")
    try:
        await run_in_threadpool(_fetch_voices)
    except Exception:
        pass
    if _voices_cache["ids"] and voice_id not in _voices_cache["ids"]:
        raise HTTPException(status_code=400, detail="unknown voice")
    text = text[:PREMIUM_TRIAL_MAX_CHARS]

    ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
          or (request.client.host if request.client else "unknown"))
    now = time.time()
    if len(_trial_ip_guard) > 5000:
        for k in [k for k, t in _trial_ip_guard.items() if now - t > PREMIUM_TRIAL_IP_COOLDOWN]:
            _trial_ip_guard.pop(k, None)
    if now - _trial_ip_guard.get(ip, 0) < PREMIUM_TRIAL_IP_COOLDOWN:
        raise HTTPException(status_code=429,
                            detail="you've used your free Studio preview — subscribe to keep going")

    ok_day, _total = daily_trial_check_and_add(len(text))
    if not ok_day:
        raise HTTPException(status_code=503,
                            detail="free previews are at capacity today — try again tomorrow or subscribe")

    try:
        audio = await run_in_threadpool(_elevenlabs_tts, text, voice_id)
    except Exception as e:
        daily_trial_refund(len(text))
        raise HTTPException(status_code=502, detail=f"trial generation failed: {e}")
    if not audio or len(audio) < 100:
        daily_trial_refund(len(text))
        raise HTTPException(status_code=502, detail="empty audio from provider")

    _trial_ip_guard[ip] = now  # mark IP used only on a successful generation
    bump_event("trial_play")
    return StreamingResponse(io.BytesIO(audio), media_type="audio/mpeg",
                             headers={"Content-Disposition": "inline"})


_ALLOWED_EVENTS = {"upgrade_open", "studio_select", "checkout_click", "sample_done"}


@router.post("/api/event")
async def track_event(request: Request):
    """Lightweight first-party funnel tracking for Studio engagement. Origin-gated;
    only an allowlist of event names is accepted."""
    if not BILLING_ENABLED:
        raise HTTPException(status_code=404, detail="billing not enabled")
    ref = request.headers.get("origin", "") or request.headers.get("referer", "")
    if ref and not ref.startswith(("https://read-aloud.com", "https://www.read-aloud.com",
                                   "http://localhost", "http://127.0.0.1")):
        raise HTTPException(status_code=403, detail="origin not allowed")
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = (body.get("name") or "").strip()
    if name in _ALLOWED_EVENTS:
        bump_event(name)
    return {"ok": True}


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


# ----------------------------------------------------------------------
# Live financials / P&L (admin only)
# ----------------------------------------------------------------------
def _money(c):
    try:
        return "$%.2f" % (int(c) / 100.0)
    except Exception:
        return "$0.00"


def _gather_finance() -> dict:
    """Pull live numbers from Stripe + ElevenLabs + the license DB. Blocking;
    call via run_in_threadpool."""
    out = {"generated": _now()}
    stripe = _get_stripe()
    now = int(time.time())
    month_ago = now - 30 * 86400

    # --- Active subscriptions -> MRR by plan ---
    plans = {}  # plan -> [count, mrr_cents]
    try:
        for sub in stripe.Subscription.list(status="active", limit=100).auto_paging_iter():
            items = _sg(sub, "items")
            data = _sg(items, "data") if items is not None else None
            if not data:
                continue
            price = _sg(data[0], "price")
            price_id = price if isinstance(price, str) else _sg(price, "id")
            amt = None if isinstance(price, str) else _sg(price, "unit_amount")
            plan = (TIERS.get(price_id) or {}).get("plan", price_id or "?")
            row = plans.setdefault(plan, [0, 0])
            row[0] += 1
            row[1] += (amt or 0)
    except Exception as e:
        out["sub_error"] = str(e)
    out["plans"] = plans
    out["active_subs"] = sum(v[0] for v in plans.values())
    out["mrr_cents"] = sum(v[1] for v in plans.values())

    # --- Exact gross / fees / net from balance transactions ---
    def sum_bt(gte):
        agg = {"gross": 0, "fee": 0, "net": 0, "refunds": 0, "charges": 0, "n": 0}
        params = {"limit": 100}
        if gte:
            params["created"] = {"gte": gte}
        for bt in stripe.BalanceTransaction.list(**params).auto_paging_iter():
            agg["n"] += 1
            if agg["n"] > 2000:
                break
            t = _sg(bt, "type")
            fee = _sg(bt, "fee", 0)
            net = _sg(bt, "net", 0)
            amount = _sg(bt, "amount", 0)
            if t in ("charge", "payment"):
                agg["gross"] += amount
                agg["fee"] += fee
                agg["net"] += net
                agg["charges"] += 1
            elif t in ("refund", "payment_refund"):
                agg["refunds"] += -amount
                agg["fee"] += fee
                agg["net"] += net
        return agg
    try:
        out["bt_30d"] = sum_bt(month_ago)
        out["bt_all"] = sum_bt(None)
    except Exception as e:
        out["bt_error"] = str(e)

    # --- Stripe balance (your money) ---
    try:
        bal = stripe.Balance.retrieve()
        out["bal_available"] = sum(_sg(b, "amount", 0) for b in (_sg(bal, "available") or []))
        out["bal_pending"] = sum(_sg(b, "amount", 0) for b in (_sg(bal, "pending") or []))
    except Exception as e:
        out["bal_error"] = str(e)

    # --- ElevenLabs usage + plan ---
    try:
        req = urllib.request.Request("https://api.elevenlabs.io/v1/user/subscription",
                                     headers={"xi-api-key": ELEVENLABS_API_KEY})
        with urllib.request.urlopen(req, timeout=15) as r:
            els = json.loads(r.read().decode())
        out["el_tier"] = els.get("tier")
        out["el_used"] = els.get("character_count")
        out["el_limit"] = els.get("character_limit")
        out["el_reset"] = els.get("next_character_count_reset_unix")
        out["el_fee_cents"] = ELEVENLABS_PLAN_FEES.get(str(els.get("tier", "")).lower())
    except Exception as e:
        out["el_error"] = str(e)
    # Fall back to the manual plan-fee override if the API didn't give us a tier.
    out["el_fee_cents"] = out.get("el_fee_cents") or (ELEVENLABS_PLAN_FEE_CENTS or None)

    # --- License DB aggregates ---
    try:
        c = _conn()
        try:
            rows = c.execute(
                "SELECT plan, status, COUNT(*) n, COALESCE(SUM(char_used),0) used "
                "FROM licenses GROUP BY plan, status ORDER BY plan").fetchall()
            out["lic_rows"] = [dict(r) for r in rows]
            today = _today()
            pd = c.execute("SELECT day, chars FROM premium_daily WHERE day IN (?,?,?)",
                           (today, "trial:" + today, "sample:" + today)).fetchall()
            d = {r["day"]: r["chars"] for r in pd}
            out["premium_today"] = d.get(today, 0)
            out["trials_today"] = d.get("trial:" + today, 0)
            tot = c.execute(
                "SELECT "
                "COALESCE(SUM(CASE WHEN day LIKE 'trial:%' THEN chars ELSE 0 END),0) trial_all, "
                "COALESCE(SUM(CASE WHEN day LIKE 'sample:%' THEN chars ELSE 0 END),0) sample_all, "
                "COALESCE(SUM(CASE WHEN day NOT LIKE 'trial:%' AND day NOT LIKE 'sample:%' "
                "         THEN chars ELSE 0 END),0) prem_all "
                "FROM premium_daily").fetchone()
            out["premium_all"] = tot["prem_all"]
            out["trials_all"] = tot["trial_all"]
            out["samples_all"] = tot["sample_all"]
            out["samples_today"] = d.get("sample:" + today, 0)
        finally:
            c.close()
    except Exception as e:
        out["lic_error"] = str(e)

    # --- Studio engagement funnel ---
    try:
        out["events"] = events_summary(
            ["sample_play", "sample_done", "studio_select", "upgrade_open",
             "trial_play", "checkout_click"])
    except Exception as e:
        out["events_error"] = str(e)

    # --- Derived P&L ---
    net30 = (out.get("bt_30d") or {}).get("net", 0)
    el_fee = out.get("el_fee_cents") or 0
    out["profit_30d_cents"] = net30 - el_fee
    return out


def _render_finance_section(d: dict) -> str:
    """Embeddable HTML (cards + tables) for the existing admin analytics page.
    Uses that page's CSS classes (.card .lbl/.val/.sub, .num, .muted)."""
    def card(label, value, sub=""):
        return (f'<div class="card"><p class="lbl">{label}</p>'
                f'<p class="val">{value}</p><p class="sub">{sub}</p></div>')

    bt30 = d.get("bt_30d") or {}
    btall = d.get("bt_all") or {}
    profit = d.get("profit_30d_cents", 0)
    el_used = d.get("el_used")
    el_limit = d.get("el_limit")
    el_pct = (f"{100*el_used/el_limit:.1f}% of limit" if el_used is not None and el_limit else "")

    parts = []

    # --- Studio engagement funnel (top of the section) ---
    ev = d.get("events") or {}
    def evrow(label, key):
        e = ev.get(key) or {"today": 0, "all": 0}
        return (f"<tr><td>{label}</td><td class='num'>{e['all']:,}</td>"
                f"<td class='num'>{e['today']:,}</td></tr>")
    parts.append("<h2>Studio engagement (funnel)</h2><table>")
    parts.append("<tr><th>Step</th><th class='num'>All-time</th><th class='num'>Today</th></tr>")
    parts.append(evrow("Voice samples played", "sample_play"))
    parts.append(evrow("Samples heard to the end", "sample_done"))
    parts.append(evrow("Studio voice selected", "studio_select"))
    parts.append(evrow("Upgrade modal opened", "upgrade_open"))
    parts.append(evrow("Free trials used", "trial_play"))
    parts.append(evrow("Checkout started", "checkout_click"))
    parts.append(f"<tr><td><strong>Subscribed (active)</strong></td>"
                 f"<td class='num'><strong>{d.get('active_subs',0)}</strong></td><td class='num'></td></tr>")
    parts.append("</table>")

    parts.append("<h2>Money — live P&amp;L</h2>")

    # Headline cards
    parts.append("<div class='cards'>")
    parts.append(card("MRR", _money(d.get("mrr_cents", 0)),
                      f"{d.get('active_subs',0)} active subs"))
    parts.append(card("Net revenue · 30d", _money(bt30.get("net", 0)),
                      f"after {_money(bt30.get('fee',0))} Stripe fees"))
    parts.append(card("Profit · 30d", _money(profit), "net rev − ElevenLabs plan"))
    parts.append(card("Stripe balance", _money(d.get("bal_available", 0)),
                      f"+ {_money(d.get('bal_pending',0))} pending"))
    parts.append("</div>")

    # Revenue detail
    parts.append("<h2>Revenue (Stripe, exact)</h2><table>")
    parts.append("<tr><th>Window</th><th class='num'>Gross</th><th class='num'>Stripe fees</th>"
                 "<th class='num'>Refunds</th><th class='num'>Net</th><th class='num'>Charges</th></tr>")
    for label, bt in (("Last 30 days", bt30), ("All time", btall)):
        parts.append(
            f"<tr><td>{label}</td><td class='num'>{_money(bt.get('gross',0))}</td>"
            f"<td class='num neg'>{_money(bt.get('fee',0))}</td>"
            f"<td class='num'>{_money(bt.get('refunds',0))}</td>"
            f"<td class='num'>{_money(bt.get('net',0))}</td>"
            f"<td class='num'>{bt.get('charges',0)}</td></tr>")
    parts.append("</table>")
    if d.get("bt_error"):
        parts.append(f"<p class='warn'>Stripe txn error: {d['bt_error']}</p>")

    # Subscriptions by plan
    parts.append("<h2>Subscribers by plan</h2><table>")
    parts.append("<tr><th>Plan</th><th class='num'>Active</th><th class='num'>MRR</th></tr>")
    for plan, (n, mrr) in sorted((d.get("plans") or {}).items()):
        parts.append(f"<tr><td>{plan}</td><td class='num'>{n}</td><td class='num'>{_money(mrr)}</td></tr>")
    if not (d.get("plans")):
        parts.append("<tr><td colspan='3' class='muted'>No active subscriptions yet.</td></tr>")
    parts.append("</table>")

    # Character usage broken out by category, with estimated marginal cost.
    def ccost(chars):
        return _money(round((chars / 1000.0) * ELEVENLABS_COST_PER_1K_CENTS))
    paid = d.get("premium_all", 0)
    trial = d.get("trials_all", 0)
    sample = d.get("samples_all", 0)
    parts.append("<h2>Character usage by source (cost side)</h2><table>")
    parts.append("<tr><th>Source</th><th class='num'>Chars (all-time)</th>"
                 "<th class='num'>Today</th><th class='num'>Est. cost</th></tr>")
    parts.append(f"<tr><td>Paid subscribers</td><td class='num'>{paid:,}</td>"
                 f"<td class='num'>{d.get('premium_today',0):,}</td><td class='num'>{ccost(paid)}</td></tr>")
    parts.append(f"<tr><td>Free trials (their text)</td><td class='num'>{trial:,}</td>"
                 f"<td class='num'>{d.get('trials_today',0):,}</td><td class='num'>{ccost(trial)}</td></tr>")
    parts.append(f"<tr><td>Voice samples (previews)</td><td class='num'>{sample:,}</td>"
                 f"<td class='num'>{d.get('samples_today',0):,}</td><td class='num'>{ccost(sample)}</td></tr>")
    parts.append(f"<tr><td><strong>Total generated</strong></td>"
                 f"<td class='num'><strong>{paid+trial+sample:,}</strong></td><td class='num'></td>"
                 f"<td class='num'><strong>{ccost(paid+trial+sample)}</strong></td></tr>")
    parts.append("</table>")

    # ElevenLabs plan / their-side usage
    el_used_s = f"{el_used:,}" if isinstance(el_used, int) else "—"
    el_limit_s = f"{el_limit:,}" if isinstance(el_limit, int) else "—"
    parts.append("<table>")
    parts.append(f"<tr><td>ElevenLabs plan tier</td><td class='num'>{d.get('el_tier') or '—'}</td></tr>")
    parts.append(f"<tr><td>Monthly plan fee</td><td class='num'>{_money(d.get('el_fee_cents') or 0)}</td></tr>")
    parts.append(f"<tr><td>EL usage this period (their API)</td><td class='num'>{el_used_s} / {el_limit_s}</td></tr>")
    parts.append(f"<tr><td>Cost rate used</td><td class='num'>{_money(ELEVENLABS_COST_PER_1K_CENTS)}/1k chars</td></tr>")
    parts.append("</table>")
    if d.get("el_error"):
        parts.append(f"<p class='muted'>ElevenLabs usage API unavailable ({d['el_error']}). "
                     f"Char counts are our own tally. Set ELEVENLABS_PLAN_FEE_CENTS for the plan cost "
                     f"and ELEVENLABS_COST_PER_1K_CENTS to tune the per-character estimate.</p>")

    # License DB / character consumption
    parts.append("<h2>Licenses &amp; character consumption</h2><table>")
    parts.append("<tr><th>Plan</th><th>Status</th><th class='num'>Licenses</th><th class='num'>Chars used</th></tr>")
    for r in (d.get("lic_rows") or []):
        parts.append(f"<tr><td>{r['plan']}</td><td>{r['status']}</td>"
                     f"<td class='num'>{r['n']}</td><td class='num'>{r['used']:,}</td></tr>")
    parts.append("</table>")
    parts.append(f"<p class='muted'>Today: {d.get('premium_today',0):,} premium chars billed to subscribers, "
                 f"{d.get('trials_today',0):,} free-trial chars.</p>")

    errs = [d[k] for k in ("sub_error", "bt_error", "el_error", "lic_error", "bal_error") if d.get(k)]
    if errs:
        parts.append("<p class='muted'>Notes: " + " | ".join(errs) + "</p>")
    parts.append(f"<p class='muted'>P&amp;L generated {d.get('generated','')}. Stripe figures are exact "
                 f"(balance transactions). Profit = 30-day net revenue minus the ElevenLabs plan fee; "
                 f"hosting (mini PC) isn't prorated.</p>")
    return "".join(parts)


def finance_section_or_empty() -> str:
    """Safe wrapper for the analytics page to embed. Returns '' on any failure."""
    if not BILLING_ENABLED:
        return ""
    try:
        return _render_finance_section(_gather_finance())
    except Exception as e:
        return f"<h2>Money — live P&amp;L</h2><p class='muted'>Finance data unavailable: {e}</p>"


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
