"""Telegram Bot API client — stdlib only, no dependencies.

Why raw HTTP: this project must run on Railway with an empty Docker image and
also in a bare sandbox with no pip. `urllib` costs nothing and removes a whole
class of deploy failures.

Buttons: `style` ("primary"|"success"|"danger") landed in Bot API 8.3 (Feb
2026). Older Telegram clients silently ignore it, so every colored button also
carries a leading emoji — the cue survives on old clients instead of vanishing.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

import config

API = f"{config.TG_API_BASE}/bot{config.BOT_TOKEN}"

# style -> emoji prefix. Telegram drops unknown fields, so this is the fallback.
STYLE_EMOJI = {"primary": "🔵", "success": "🟢", "danger": "🔴", None: ""}


class TgError(Exception):
    pass


def api(method: str, timeout: int = 30, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{API}/{method}", data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            raise TgError(f"{method}: HTTP {e.code}") from e
    except Exception as e:  # network
        raise TgError(f"{method}: {e}") from e
    if not payload.get("ok"):
        raise TgError(f"{method}: {payload.get('description')}")
    return payload.get("result")


def btn(text: str, data: str | None = None, url: str | None = None,
        style: str | None = None, copy: str | None = None, web_app: str | None = None) -> dict:
    b: dict = {"text": f"{STYLE_EMOJI.get(style, '')}{text}" if style else text}
    if data is not None:
        b["callback_data"] = data
    if url:
        b["url"] = url
    if web_app:
        b["web_app"] = {"url": web_app}
    if copy is not None:
        b["copy_text"] = {"text": copy}
    if style:
        b["style"] = style
    return b


def kb(*rows) -> dict:
    return {"inline_keyboard": [list(r) for r in rows if r]}


def send(chat_id, text, keyboard=None, parse_mode="HTML", disable_preview=True, reply_to=None):
    p = dict(chat_id=chat_id, text=text[:4096], parse_mode=parse_mode,
             link_preview_options={"is_disabled": disable_preview})
    if keyboard:
        p["reply_markup"] = keyboard
    if reply_to:
        p["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
    return api("sendMessage", **p)


def edit(chat_id, message_id, text, keyboard=None, parse_mode="HTML"):
    p = dict(chat_id=chat_id, message_id=message_id, text=text[:4096], parse_mode=parse_mode,
             link_preview_options={"is_disabled": True})
    if keyboard:
        p["reply_markup"] = keyboard
    try:
        return api("editMessageText", **p)
    except TgError as e:
        if "not modified" in str(e).lower():
            return None
        raise


def copy(chat_id, from_chat_id, message_id, reply_to=None, keyboard=None):
    p = dict(chat_id=chat_id, from_chat_id=from_chat_id, message_id=message_id)
    if reply_to:
        p["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
    if keyboard:
        p["reply_markup"] = keyboard
    return api("copyMessage", **p)


def answer_cb(cb_id, text=None, alert=False):
    p = {"callback_query_id": cb_id}
    if text:
        p.update(text=text[:200], show_alert=alert)
    try:
        return api("answerCallbackQuery", **p)
    except TgError:
        return None


def set_commands(scope=None):
    cmds = [
        {"command": "start", "description": "شروع / Start"},
        {"command": "menu", "description": "منوی اصلی / Main menu"},
        {"command": "panel", "description": "پنل مدیریت / Admin panel"},
        {"command": "help", "description": "راهنما / Help"},
    ]
    p = {"commands": cmds}
    if scope:
        p["scope"] = scope
    return api("setMyCommands", **p)


def get_updates(offset=0, timeout=30):
    return api("getUpdates", timeout=timeout + 10, offset=offset, timeout=timeout,
               allowed_updates=["message", "callback_query"])


def me():
    return api("getMe")


def delete(chat_id, message_id):
    try:
        return api("deleteMessage", chat_id=chat_id, message_id=message_id)
    except TgError:
        return None


def escape(text: str) -> str:
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def poll_loop(handler, stop=None):
    """Long polling in the calling thread. handler(update) must never raise."""
    offset = 0
    backoff = 1.0
    while not (stop and stop.is_set()):
        try:
            updates = get_updates(offset, timeout=30)
            backoff = 1.0
        except TgError as e:
            # 409 = another poller is alive (a second replica). Back off instead
            # of hammering the API; Railway health checks still pass.
            print(f"[tg] poll error: {e}", flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue
        for u in updates or []:
            offset = max(offset, u["update_id"] + 1)
            try:
                handler(u)
            except Exception as e:  # one bad update must not kill the bot
                print(f"[tg] handler error: {type(e).__name__}: {e}", flush=True)
