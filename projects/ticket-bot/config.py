"""Runtime configuration — everything comes from environment variables.

On Railway the persistent volume is mounted at /data, so the SQLite file and
uploads live there and survive redeploys. Nothing secret is hard-coded; the
panel secret is generated once and stored in the database if it is missing.
"""
from __future__ import annotations

import os
from pathlib import Path


def _int(name: str, default: int = 0) -> int:
    try:
        return int(str(os.environ.get(name, "")).strip() or default)
    except ValueError:
        return default


BOT_TOKEN = (os.environ.get("BOT_TOKEN") or "").strip()
BOT_USERNAME = (os.environ.get("BOT_USERNAME") or "").strip().lstrip("@")

# Super-owner: this Telegram id sees the platform-level view (all tenants).
OWNER_TG_ID = _int("OWNER_TG_ID", 0)

# Railway volume.
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = Path(os.environ.get("DB_PATH", str(DATA_DIR / "ticketbot.db")))
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", str(DATA_DIR / "uploads")))

PORT = _int("PORT", 8080)
TG_API_BASE = (os.environ.get("TG_API_BASE") or "https://api.telegram.org").rstrip("/")

# Session lifetime for the web panel (seconds).
SESSION_TTL = _int("SESSION_TTL", 12 * 3600)

# Local development fallback only. On Railway set PANEL_SECRET explicitly.
PANEL_SECRET = (os.environ.get("PANEL_SECRET") or "").strip()

DEV = os.environ.get("DEV", "").strip() in {"1", "true", "yes"}


def ensure_dirs() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
