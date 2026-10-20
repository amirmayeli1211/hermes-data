"""Business rules shared by the bot and the web panel: SLA, working hours,
auto-assignment with per-agent capacity, ticket numbering and formatting.
"""
from __future__ import annotations

import datetime as dt

import config
import db

PRIORITY_LABEL = {"urgent": "🔴 فوری", "normal": "🟡 عادی", "low": "⚪️ کم"}
STATUS_LABEL = {"open": "🟢 باز", "pending": "🟡 در انتظار", "closed": "⚪️ بسته"}
ROLE_LABEL = {"owner": "👑 مالک", "admin": "🛡 ادمین", "agent": "🎧 اپراتور",
              "readonly": "👁 فقط‌خواندنی"}


def sla_seconds(tenant_id: int) -> int:
    try:
        return max(1, int(db.get_setting(tenant_id, "sla_minutes", "60"))) * 60
    except ValueError:
        return 3600


def overdue(ticket) -> bool:
    """Open ticket whose customer is still waiting beyond the SLA window."""
    if ticket["status"] != "open":
        return False
    anchor = ticket["last_customer_msg_at"] or ticket["created_at"]
    return (db.now() - anchor) > sla_seconds(ticket["tenant_id"])


def outside_hours(tenant_id: int) -> bool:
    raw = db.get_setting(tenant_id, "business_hours", "").strip()
    if not raw or "-" not in raw:
        return False  # no hours configured -> always open
    try:
        start_s, end_s = raw.split("-", 1)
        sh, sm = (int(x) for x in start_s.strip().split(":"))
        eh, em = (int(x) for x in end_s.strip().split(":"))
    except ValueError:
        return False
    now = dt.datetime.now()
    start = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end = now.replace(hour=eh, minute=em, second=0, microsecond=0)
    if end <= start:  # overnight window, e.g. 22:00-06:00
        return not (now >= start or now <= end)
    return not (start <= now <= end)


def agent_load(tenant_id: int, tg_id: int) -> int:
    return db.scalar(
        "SELECT COUNT(*) FROM tickets WHERE tenant_id=? AND assigned_to=?"
        " AND status!='closed'", (tenant_id, tg_id))


def pick_agent(tenant_id: int, capacity: int = 10):
    """Least-loaded active agent/admin below capacity, else None (queue)."""
    best, best_load = None, 10**9
    for m in db.tenant_staff(tenant_id, ("owner", "admin", "agent")):
        load = agent_load(tenant_id, m["tg_id"])
        if load < capacity and load < best_load:
            best, best_load = m, load
    return best


def fmt_ticket(t, tenant_name: str = "") -> str:
    lines = [
        f"<b>تیکت #{t['number']}</b>",
        f"👤 مشتری: {t['customer_name'] or t['customer_id']}",
        f"📌 موضوع: {t['subject'] or '—'}",
        f"⚡️ اولویت: {PRIORITY_LABEL.get(t['priority'], t['priority'])}",
        f"📍 وضعیت: {STATUS_LABEL.get(t['status'], t['status'])}",
    ]
    if t["assigned_to"]:
        lines.append(f"🎧 اپراتور: <code>{t['assigned_to']}</code>")
    if overdue(t):
        lines.append("⏰ <b>از SLA گذشته</b>")
    if t["rating"]:
        lines.append(f"⭐️ امتیاز: {t['rating']}/5")
    return "\n".join(lines)


def minutes_since(ts: int) -> int:
    return max(0, (db.now() - int(ts or 0)) // 60)


def human_dt(ts) -> str:
    if not ts:
        return "—"
    return dt.datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M")
