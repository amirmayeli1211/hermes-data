"""SQLite layer for the multi-tenant ticket bot — one flat file, no ORM.

Design notes
    * Multi-tenant from day one: every row that belongs to a business carries
      `tenant_id`. Adding tenancy later would be a schema rewrite, so it is
      cheap now and impossible later.
    * WAL mode: the bot (async) and the web panel (sync) write concurrently.
    * Times are integer unix seconds (UTC) — no timezone soup.
"""
from __future__ import annotations

import secrets
import sqlite3
import time
from contextlib import contextmanager

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS tenants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    slug        TEXT    UNIQUE,
    owner_tg_id INTEGER,
    status      TEXT    NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
    tg_id      INTEGER NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'agent',   -- owner|admin|agent|readonly
    name       TEXT,
    username   TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE (tenant_id, tg_id)
);

CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
    tg_id       INTEGER NOT NULL,
    name        TEXT,
    username    TEXT,
    tag         TEXT,
    verified_at INTEGER,
    created_at  INTEGER NOT NULL,
    UNIQUE (tenant_id, tg_id)
);

CREATE TABLE IF NOT EXISTS tickets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id           INTEGER NOT NULL REFERENCES tenants(id),
    customer_id         INTEGER NOT NULL REFERENCES customers(id),
    number              INTEGER NOT NULL,          -- per-tenant human number
    subject             TEXT,
    priority            TEXT NOT NULL DEFAULT 'normal',  -- urgent|normal|low
    status              TEXT NOT NULL DEFAULT 'open',     -- open|pending|closed
    assigned_to         INTEGER,                   -- members.tg_id
    rating              INTEGER,                   -- 1..5 after close
    created_at          INTEGER NOT NULL,
    first_reply_at      INTEGER,
    last_customer_msg_at INTEGER,
    closed_at           INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
    sender_type TEXT    NOT NULL,                  -- customer|agent|system
    sender_id   INTEGER,
    body        TEXT,
    file_id     TEXT,
    file_type   TEXT,                              -- photo|document|voice|video
    is_internal INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    tenant_id INTEGER NOT NULL,
    key       TEXT    NOT NULL,
    value     TEXT,
    PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS verify_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER,
    tg_id       INTEGER NOT NULL,
    code        TEXT    NOT NULL,
    purpose     TEXT    NOT NULL,                  -- customer_verify|panel_login
    created_at  INTEGER NOT NULL,
    consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    tg_id      INTEGER NOT NULL,
    tenant_id  INTEGER,
    role       TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS states (
    tg_id      INTEGER PRIMARY KEY,
    tenant_id  INTEGER,
    state      TEXT,
    data       TEXT,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER,
    actor_tg_id INTEGER,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_tenant   ON tickets(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_messages_ticket  ON messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
"""

DEFAULT_SETTINGS = {
    "welcome_text": "سلام 👋 به پشتیبانی {tenant} خوش آمدی.\nاز منوی زیر انتخاب کن:",
    "outside_hours_text": "",
    "business_hours": "09:00-18:00",
    "sla_minutes": "60",
    "support_url": "",
    "auto_close_hours": "0",
}


def now() -> int:
    return int(time.time())


@contextmanager
def tx():
    """One connection per unit of work. WAL keeps readers unblocked."""
    conn = sqlite3.connect(config.DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init() -> None:
    config.ensure_dirs()
    with tx() as c:
        c.executescript(SCHEMA)


def q(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    with tx() as c:
        return c.execute(sql, args).fetchall()


def one(sql: str, args: tuple = ()) -> sqlite3.Row | None:
    with tx() as c:
        return c.execute(sql, args).fetchone()


def scalar(sql: str, args: tuple = (), default=0):
    row = one(sql, args)
    if row is None:
        return default
    v = row[0]
    return default if v is None else v


def ex(sql: str, args: tuple = ()) -> int:
    """Execute and return lastrowid."""
    with tx() as c:
        cur = c.execute(sql, args)
        return cur.lastrowid or 0


def audit(tenant_id, actor_tg_id, action, target=None, detail=None) -> None:
    ex(
        "INSERT INTO audit(tenant_id, actor_tg_id, action, target, detail, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (tenant_id, actor_tg_id, action, target, detail, now()),
    )


# ---------------------------------------------------------------- tenants

def create_tenant(name: str, owner_tg_id: int = 0) -> int:
    slug = "".join(ch for ch in name.lower().replace(" ", "-") if ch.isalnum() or ch == "-") or None
    tid = ex(
        "INSERT INTO tenants(name, slug, owner_tg_id, created_at) VALUES (?,?,?,?)",
        (name, slug, owner_tg_id, now()),
    )
    for k, v in DEFAULT_SETTINGS.items():
        ex("INSERT OR IGNORE INTO settings(tenant_id, key, value) VALUES (?,?,?)", (tid, k, v))
    if owner_tg_id:
        add_member(tid, owner_tg_id, "owner")
    return tid


def get_tenant(tenant_id: int):
    return one("SELECT * FROM tenants WHERE id=?", (tenant_id,))


def first_tenant():
    return one("SELECT * FROM tenants WHERE status='active' ORDER BY id LIMIT 1")


def all_tenants():
    return q("SELECT * FROM tenants ORDER BY id")


# ---------------------------------------------------------------- members

def add_member(tenant_id: int, tg_id: int, role: str = "agent", name=None, username=None) -> int:
    ex(
        "INSERT INTO members(tenant_id, tg_id, role, name, username, created_at)"
        " VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(tenant_id, tg_id) DO UPDATE SET role=excluded.role, active=1",
        (tenant_id, tg_id, role, name, username, now()),
    )
    return scalar("SELECT id FROM members WHERE tenant_id=? AND tg_id=?", (tenant_id, tg_id))


def member_of(tg_id: int):
    """Highest-privilege membership of this telegram user."""
    order = "CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'agent' THEN 2 ELSE 3 END"
    return one(
        f"SELECT * FROM members WHERE tg_id=? AND active=1 ORDER BY {order} LIMIT 1", (tg_id,)
    )


def tenant_staff(tenant_id: int, roles=("owner", "admin", "agent")):
    marks = ",".join("?" for _ in roles)
    return q(
        f"SELECT * FROM members WHERE tenant_id=? AND active=1 AND role IN ({marks})",
        (tenant_id, *roles),
    )


# ---------------------------------------------------------------- customers

def add_customer(tenant_id: int, tg_id: int, name=None, username=None, tag=None) -> int:
    ex(
        "INSERT INTO customers(tenant_id, tg_id, name, username, tag, created_at)"
        " VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id, tg_id) DO UPDATE SET"
        " name=COALESCE(excluded.name, customers.name),"
        " username=COALESCE(excluded.username, customers.username),"
        " tag=COALESCE(excluded.tag, customers.tag)",
        (tenant_id, tg_id, name, username, tag, now()),
    )
    return scalar("SELECT id FROM customers WHERE tenant_id=? AND tg_id=?", (tenant_id, tg_id))


def customer_by_tg(tg_id: int):
    return one(
        "SELECT c.*, t.name AS tenant_name FROM customers c"
        " JOIN tenants t ON t.id=c.tenant_id WHERE c.tg_id=? ORDER BY c.id LIMIT 1",
        (tg_id,),
    )


def mark_customer_verified(customer_id: int) -> None:
    ex("UPDATE customers SET verified_at=? WHERE id=?", (now(), customer_id))


def tenant_customers(tenant_id: int):
    return q("SELECT * FROM customers WHERE tenant_id=? ORDER BY id DESC", (tenant_id,))


# ---------------------------------------------------------------- tickets

def next_ticket_number(tenant_id: int) -> int:
    return scalar("SELECT COALESCE(MAX(number),0)+1 FROM tickets WHERE tenant_id=?", (tenant_id,), 1)


def create_ticket(tenant_id: int, customer_id: int, subject: str, priority: str = "normal") -> int:
    number = next_ticket_number(tenant_id)
    return ex(
        "INSERT INTO tickets(tenant_id, customer_id, number, subject, priority, created_at,"
        " last_customer_msg_at) VALUES (?,?,?,?,?,?,?)",
        (tenant_id, customer_id, number, subject, priority, now(), now()),
    )


def get_ticket(ticket_id: int):
    return one(
        "SELECT tk.*, c.tg_id AS customer_tg_id, c.name AS customer_name,"
        " c.username AS customer_username"
        " FROM tickets tk JOIN customers c ON c.id=tk.customer_id WHERE tk.id=?",
        (ticket_id,),
    )


def open_ticket_for(tg_id: int):
    return one(
        "SELECT tk.* FROM tickets tk JOIN customers c ON c.id=tk.customer_id"
        " WHERE c.tg_id=? AND tk.status!='closed' ORDER BY tk.id DESC LIMIT 1",
        (tg_id,),
    )


def tenant_tickets(tenant_id: int, status: str | None = None, limit: int = 200):
    if status:
        return q(
            "SELECT tk.*, c.tg_id AS customer_tg_id, c.name AS customer_name"
            " FROM tickets tk JOIN customers c ON c.id=tk.customer_id"
            " WHERE tk.tenant_id=? AND tk.status=? ORDER BY tk.id DESC LIMIT ?",
            (tenant_id, status, limit),
        )
    return q(
        "SELECT tk.*, c.tg_id AS customer_tg_id, c.name AS customer_name"
        " FROM tickets tk JOIN customers c ON c.id=tk.customer_id"
        " WHERE tk.tenant_id=? ORDER BY tk.id DESC LIMIT ?",
        (tenant_id, limit),
    )


def customer_tickets(customer_id: int, limit: int = 20):
    return q(
        "SELECT * FROM tickets WHERE customer_id=? ORDER BY id DESC LIMIT ?",
        (customer_id, limit),
    )


def set_ticket_status(ticket_id: int, status: str) -> None:
    if status == "closed":
        ex("UPDATE tickets SET status=?, closed_at=? WHERE id=?", (status, now(), ticket_id))
    else:
        ex("UPDATE tickets SET status=? WHERE id=?", (status, ticket_id))


def assign_ticket(ticket_id: int, tg_id: int | None) -> None:
    ex("UPDATE tickets SET assigned_to=? WHERE id=?", (tg_id, ticket_id))


def rate_ticket(ticket_id: int, rating: int) -> None:
    ex("UPDATE tickets SET rating=? WHERE id=?", (rating, ticket_id))


def add_message(ticket_id: int, sender_type: str, sender_id, body, file_id=None,
                file_type=None, internal=False) -> int:
    mid = ex(
        "INSERT INTO messages(ticket_id, sender_type, sender_id, body, file_id, file_type,"
        " is_internal, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (ticket_id, sender_type, sender_id, body, file_id, file_type,
         1 if internal else 0, now()),
    )
    if sender_type == "customer":
        ex("UPDATE tickets SET last_customer_msg_at=?, status=CASE WHEN status='pending'"
           " THEN 'open' ELSE status END WHERE id=?", (now(), ticket_id))
    else:
        ex("UPDATE tickets SET first_reply_at=COALESCE(first_reply_at,?) WHERE id=?",
           (now(), ticket_id))
    return mid


def ticket_messages(ticket_id: int, include_internal: bool = False):
    if include_internal:
        return q("SELECT * FROM messages WHERE ticket_id=? ORDER BY id", (ticket_id,))
    return q(
        "SELECT * FROM messages WHERE ticket_id=? AND is_internal=0 ORDER BY id", (ticket_id,)
    )


# ---------------------------------------------------------------- settings

def get_setting(tenant_id: int, key: str, default: str = "") -> str:
    row = one("SELECT value FROM settings WHERE tenant_id=? AND key=?", (tenant_id, key))
    return default if row is None or row["value"] is None else row["value"]


def set_setting(tenant_id: int, key: str, value: str) -> None:
    ex(
        "INSERT INTO settings(tenant_id, key, value) VALUES (?,?,?)"
        " ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value",
        (tenant_id, key, value),
    )


def all_settings(tenant_id: int) -> dict:
    rows = q("SELECT key, value FROM settings WHERE tenant_id=?", (tenant_id,))
    return {r["key"]: r["value"] for r in rows}


# ---------------------------------------------------------------- codes / sessions

def issue_code(tenant_id, tg_id: int, purpose: str, ttl: int = 900) -> str:
    # Invalidate older codes for the same (user, purpose) so only one is live.
    ex(
        "UPDATE verify_codes SET consumed_at=? WHERE tg_id=? AND purpose=? AND consumed_at IS NULL",
        (now(), tg_id, purpose),
    )
    code = f"{secrets.randbelow(900000) + 100000}"
    ex(
        "INSERT INTO verify_codes(tenant_id, tg_id, code, purpose, created_at) VALUES (?,?,?,?,?)",
        (tenant_id, tg_id, code, purpose, now()),
    )
    return code


def check_code(tg_id: int, code: str, purpose: str, ttl: int = 900) -> bool:
    row = one(
        "SELECT * FROM verify_codes WHERE tg_id=? AND purpose=? AND consumed_at IS NULL"
        " ORDER BY id DESC LIMIT 1",
        (tg_id, purpose),
    )
    if row is None or row["code"] != str(code).strip():
        return False
    if now() - row["created_at"] > ttl:
        return False
    ex("UPDATE verify_codes SET consumed_at=? WHERE id=?", (now(), row["id"]))
    return True


def create_session(tg_id: int, tenant_id, role: str) -> str:
    token = secrets.token_urlsafe(32)
    ex(
        "INSERT INTO sessions(token, tg_id, tenant_id, role, created_at, expires_at)"
        " VALUES (?,?,?,?,?,?)",
        (token, tg_id, tenant_id, role, now(), now() + config.SESSION_TTL),
    )
    return token


def session_user(token: str):
    if not token:
        return None
    row = one("SELECT * FROM sessions WHERE token=?", (token,))
    if row is None or row["expires_at"] < now():
        return None
    return row


def drop_session(token: str) -> None:
    ex("DELETE FROM sessions WHERE token=?", (token,))


# ---------------------------------------------------------------- fsm states

def set_state(tg_id: int, state: str | None, tenant_id=None, data=None) -> None:
    if state is None:
        ex("DELETE FROM states WHERE tg_id=?", (tg_id,))
        return
    ex(
        "INSERT INTO states(tg_id, tenant_id, state, data, updated_at) VALUES (?,?,?,?,?)"
        " ON CONFLICT(tg_id) DO UPDATE SET tenant_id=excluded.tenant_id,"
        " state=excluded.state, data=excluded.data, updated_at=excluded.updated_at",
        (tg_id, tenant_id, state, data, now()),
    )


def get_state(tg_id: int):
    return one("SELECT * FROM states WHERE tg_id=?", (tg_id,))


# ---------------------------------------------------------------- stats

def stats(tenant_id: int) -> dict:
    total = scalar("SELECT COUNT(*) FROM tickets WHERE tenant_id=?", (tenant_id,))
    open_ = scalar("SELECT COUNT(*) FROM tickets WHERE tenant_id=? AND status='open'", (tenant_id,))
    pending = scalar("SELECT COUNT(*) FROM tickets WHERE tenant_id=? AND status='pending'", (tenant_id,))
    closed = scalar("SELECT COUNT(*) FROM tickets WHERE tenant_id=? AND status='closed'", (tenant_id,))
    avg_rating = scalar("SELECT AVG(rating) FROM tickets WHERE tenant_id=? AND rating IS NOT NULL",
                        (tenant_id,), 0)
    avg_first = scalar(
        "SELECT AVG(first_reply_at - created_at) FROM tickets"
        " WHERE tenant_id=? AND first_reply_at IS NOT NULL", (tenant_id,), 0)
    customers = scalar("SELECT COUNT(*) FROM customers WHERE tenant_id=?", (tenant_id,))
    unverified = scalar(
        "SELECT COUNT(*) FROM customers WHERE tenant_id=? AND verified_at IS NULL", (tenant_id,))
    return {
        "total": total, "open": open_, "pending": pending, "closed": closed,
        "rating": round(float(avg_rating or 0), 2),
        "first_reply_min": round(float(avg_first or 0) / 60, 1),
        "customers": customers, "unverified": unverified,
    }
