---
name: python-telegram-bots
description: "Build stdlib-only Telegram bots, flat layout, Railway-ready."
version: 1.0.0
author: Reza + Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [telegram, bot, python, stdlib, railway, multi-tenant, tickets]
---

# Python Telegram Bots (stdlib-first)

Reza's product line is Telegram bots (support/ticket panels, CRM-style
customer handling). This is the shape that ships: pure standard library,
flat module layout, one private GitHub repo per bot, Railway deploy, and an
offline self-test that proves the logic before any token is involved.

## When to Use

- Reza asks for a Telegram bot, support/ticket panel, or CRM-style customer
  bot — start from this shape rather than proposing a framework.
- The bot must run on Railway (or any host with no pip and a small disk).
- A project already in this shape needs a new flow, module, or deploy change.

## Standing constraints (non-negotiable)

- **No third-party dependencies.** `urllib` for the Bot API, `sqlite3` for
  storage, `http.server` for the health endpoint. `requirements.txt` carries
  comments only. This is what makes the Docker build install-free and the
  code runnable in a sandbox with no pip.
- **Flat layout**: every file at the repo root, no subfolders, no packages.
- **≤ 500 KB per file** (measure with `os.path.getsize`; report the largest
  file rather than just asserting compliance).
- **Buttons over commands**: users act through inline keyboards; typed
  commands exist only as `/start`, `/menu`, `/panel`, `/help`, all registered
  via `setMyCommands`.
- **GitHub only**: stage, push, verify the remote tree, then delete the local
  staging copy. Project code does not live on the machine's disk.
- Reza wants a short Persian status line after every batch of work — end
  turns frequently instead of running one long silent turn.

## Module map (flat, one role each)

config → migrations → database → models → validators → formatters → audit →
repositories → callbacks → keyboards → permissions → error_handler →
verification → {tenant,ticket,operator}_manager → notifications / sla_manager /
reports → {user,admin,owner,ticket,customer}_handlers → handlers (dispatcher)
→ bot (API client + entrypoint) → scheduler / backup / healthcheck → deploy
files (Procfile, railway.json, Dockerfile, .env.example, .gitignore, README).

Layer rule: repositories own ALL SQL and are tenant-scoped; managers own rules
(stamps, audit rows, assignment); handlers own I/O and stay thin; nobody
calls the Telegram API except `bot.py`.

## Procedure

1. Confirm the module list and constraints, then write files in dependency
   order, keeping each `py_compile`-clean as you go (the write tool lints).
2. Build the callback scheme first: `enc(prefix, *parts)` / `decode(data)`,
   64-byte cap enforced with a raise, one parser for the whole bot — no
   handler ever splits raw callback_data itself.
3. FSM states live in a table keyed by tg_id; the dispatcher maps state →
   handler and CLEARS unknown states instead of looping on them.
4. Write the offline self-test before declaring done (see
   `references/offline-selftest.md`): stub the API, temp DB, real end-to-end
   flows, health endpoint over urllib, exit non-zero on any FAIL.
5. Ship: stage under `/data/.hermes/cache/scratch/`, `git init` + commit,
   push with a GIT_ASKPASS script that reads the token sidecar (token never in
   the URL or argv), then verify the remote tree against local (file count,
   missing, extra, `truncated`), then delete the staging dir.

## Pitfalls (each cost a real failure)

- **`sqlite3.Row` has no `.get()`.** Returning raw Rows from the DB layer
  crashes every formatter that calls `.get()`, and only at runtime. Return
  `dict(row)` from `q()`/`one()`; keep `scalar()` on raw tuples because its
  result column is unnamed.
- **Bot ids vs humans**: an id-shape heuristic (`>= 1e9` and ending in `000`)
  only screens out obvious bots; the authoritative check is `getChat`. A user
  who never pressed Start cannot be messaged at all — that deserves its own
  Persian message to the admin, not a generic failure.
- **`style` on buttons needs Bot API 8.3+, `copy_text` 7.11+**; older clients
  ignore unknown fields, so colors degrade silently — put the meaning in the
  button text. The copy-text button is the right pattern for verification
  codes (one tap fills the input box; also show the code as `<code>` text).
- **`getUpdates` 409 means a second poller is alive** (second replica or a
  leftover local process). Back off exponentially; never tight-loop.
- **Auto-assignment pools include owner and admin**, not just agents, and must
  respect per-member capacity; least-loaded with a deterministic tie-break.
- **SLA reminders must be idempotent**: one fire per overdue window, and a new
  customer message re-arms it (`sla_notified_at` older than
  `last_customer_msg_at`).
- **Railway needs `$PORT`, a `/health` endpoint, and a volume mounted at
  `/data`**; put the DB and backups there so redeploys do not wipe them.
- **`DEV=1`** boots without a token so the self-test and a local smoke run
  work with zero secrets.

Support file: `references/offline-selftest.md` — the stub harness, the check
list, and the flows a bot of this shape must pass before it ships.
