#!/usr/bin/env python3
# store.py — minimal persistence for premium generation sessions

"""A tiny SQLite-backed store for tracking Stripe sessions.

This module provides helper functions to create and manage session
records for the premium MP3 generation flow. Each record tracks whether
the checkout session has been paid and whether the associated MP3
generation has been used. This ensures that each purchase can only be
redeemed once. A timestamp is also stored for potential cleanup of
stale sessions.
"""

import sqlite3
import pathlib
import time
from typing import Optional

# Database file path relative to this module. In production you might
# choose a persistent mount point instead. SQLite will create the
# database file if it does not exist.
DB = pathlib.Path(__file__).resolve().parent / "premium.db"


def _ensure() -> sqlite3.Connection:
    """Ensure the sessions table exists and return a connection."""
    conn = sqlite3.connect(DB)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            paid INTEGER DEFAULT 0,
            used INTEGER DEFAULT 0,
            created_at INTEGER
        )
        """
    )
    conn.commit()
    return conn


def create_pending(session_id: str) -> None:
    """Insert a new pending session if it does not exist."""
    conn = _ensure()
    conn.execute(
        "INSERT OR IGNORE INTO sessions(session_id, paid, used, created_at) VALUES (?, 0, 0, ?)",
        (session_id, int(time.time())),
    )
    conn.commit()
    conn.close()


def mark_paid(session_id: str) -> None:
    """Mark the given session as paid."""
    conn = _ensure()
    conn.execute(
        "UPDATE sessions SET paid = 1 WHERE session_id = ?", (session_id,)
    )
    conn.commit()
    conn.close()


def is_paid_and_unused(session_id: str) -> bool:
    """Return True if the session has been paid for and not yet used."""
    conn = _ensure()
    cur = conn.execute(
        "SELECT paid, used FROM sessions WHERE session_id = ?", (session_id,)
    )
    row = cur.fetchone()
    conn.close()
    return bool(row and row[0] == 1 and row[1] == 0)


def mark_used(session_id: str) -> None:
    """Mark the given session as used."""
    conn = _ensure()
    conn.execute(
        "UPDATE sessions SET used = 1 WHERE session_id = ?", (session_id,)
    )
    conn.commit()
    conn.close()
