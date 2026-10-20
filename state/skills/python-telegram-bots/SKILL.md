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
  turns frequently instead of running one long silent turn. Concretely: one
  line, present tense, what landed and what is next ("migration 6 added ✅
  حالا پنل مشتری"), between tool batches — not a wall of explanation and not
  silence until the end. He benchmarks against the fastest session he has
  had; long silent stretches read as "stuck", so ship the small step and
  report it rather than batching everything behind one final summary.

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

1. **Restate the product model as a layer diagram and get a yes before
   writing code.** These bots are multi-layer products (platform owner →
   paying customer → shop → end user), and a one-level misreading costs a
   full redesign, not a patch. One short message: who sits at each layer,
   who creates whom, and where a ticket stops. Do not start building on an
   inferred hierarchy — ask the single open question (e.g. "how many shops
   per customer?") and let the answer fix the schema.
2. Confirm the module list and constraints, then write files in dependency
   order, keeping each `py_compile`-clean as you go (the write tool lints).
3. Build the callback scheme first: `enc(prefix, *parts)` / `decode(data)`,
   64-byte cap enforced with a raise, one parser for the whole bot — no
   handler ever splits raw callback_data itself.
4. FSM states live in a table keyed by tg_id; the dispatcher maps state →
   handler and CLEARS unknown states instead of looping on them.
5. Write the offline self-test before declaring done (see
   `references/offline-selftest.md`): stub the API, temp DB, real end-to-end
   flows, health endpoint over urllib, exit non-zero on any FAIL.
6. Ship: stage under `/data/.hermes/cache/scratch/`, `git init` + commit,
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
- **Report the finish with a commit hash and the verification counts** —
  "`5332e45`, 55 checks PASS + 33 regression PASS", and the numbers must come
  from a real run in this session. Reza checks the claim ("did the tests
  actually pass?"), so an unverified "all good" costs more trust than a
  failing test reported honestly.
- **Re-read the row after a mutating repo call before rendering or notifying
  from it.** A dict loaded before `attach_receipt()` still has
  `receipt_file_id = None`, so the owner's alert goes out text-only and the
  receipt silently never arrives; `row = repo.get(row["id"])` after the write.
  Same shape for any "load, mutate, then message about it" sequence.
- **Every button needs a route — prove it by tapping all of them.** A "change
  card holder" button shipped with no matching op and did nothing at all. The
  cheapest gate is a test that iterates each role's main menu, taps every
  `callback_data`, and fails on any exception; run it after every new button.
- **A payment/info screen must print the value as text, not only hide it behind
  a `copy_text` button.** The copy button is a convenience for one device; the
  printed card number is the requirement. Shipping only the button reads as
  "where do I even pay".
- **Media sends go through `bot.api("sendPhoto"/"sendDocument",
  reply_markup=..., caption=...)`** — the thin `bot.send` wrapper has no media
  variant, so do not invent `bot.send_media`. Pick a photo receipt by largest
  `file_size` and fall back to the LAST entry (Telegram sends ascending sizes);
  hand-built test updates often omit `file_size` entirely.
- **A limit that lives on a joined table must be joined in EVERY accessor.**
  A row-fetch helper (`get_account`) returning the bare row while the list
  helper joins the plan makes `max_shops` come back `None`, and every caller's
  `or 1` fallback silently caps the plan at its minimum — no error, wrong
  product. Join in the single-row getter too, and assert the plan name is
  present in the test rather than only the cap.
- **Validate input before clearing FSM state.** Clearing first (`clear_state`
  at the top of the state handler) means one typo ejects the user from a
  multi-step flow and they must restart it; send the retry message, return,
  and clear only on success. Same rule for any flow whose last step is a
  numeric id.
- **Two verify purposes must be checked in one place, in order.** When both
  an account-level code and a customer-level code can arrive as plain text,
  try them explicitly (account first, then customer) at the single entry
  point — otherwise a bare digit string falls through to the "I did not
  understand" branch and the buyer can never activate.
- **Binding a sub-entity (shop/store) into ctx must come from an
  ownership-checked lookup**, never from a callback argument. `ctx["tenant_id"]
  = shop["id"]` only after verifying `shop["account_id"] == account["id"]`;
  everything downstream (settings, operators, tickets) trusts that field.
- **Group tickets: a user who never pressed Start cannot receive a DM.** Put
  the operator reply into the bound group as a threaded reply to the
  customer's last message when the DM raises `TgError` — do not treat the
  reply as failed. Ack only the ticket's FIRST message, and decide "first" by
  message count (`len(list_messages(ticket_id)) == 1`) — second-resolution
  timestamps make two messages in one second both look new and spam the group.
  Staff messages in the group must never become tickets (check membership
  first).

Support files: `references/offline-selftest.md` — the stub harness, the check
list, and the flows a bot of this shape must pass before it ships.
`references/platform-reseller-model.md` — how to layer plans → accounts →
shops above the tenant table when the product is a platform rather than one
company's helpdesk, plus the self-service purchase flow (prices, owner's card,
receipt upload, approve/reject) that sells a plan without the owner adding
anyone by hand.
