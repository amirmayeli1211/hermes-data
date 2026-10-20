# Offline self-test for a stdlib Telegram bot

Goal: prove every business flow with no network and no token. One script,
`check(name, cond, extra)` helpers, print PASS/FAIL per line, exit non-zero on
any FAIL.

## Harness

- Set env BEFORE importing project modules: `DEV=1`, `DATA_DIR` / `DB_PATH` /
  `BACKUP_DIR` under `tempfile.mkdtemp()`, a fake `BOT_TOKEN=1:test`,
  `OWNER_TG_ID`, and a free `PORT`.
- Stub outbound I/O after imports:
  `bot.send = lambda chat_id, text, keyboard=None, **kw: SENT.append(...)`
  returning a fake message dict, `bot.api = lambda *a, **k: {...}` for getChat,
  and `notifications._try = ...`. Keep everything recorded in a list so later
  checks can assert on what WOULD have been sent ("the customer received the
  panel menu", "the code reached the invited user").
- Point `sys.path` at the project dir and run the script from OUTSIDE it, so
  the shipped tree never collects test files.

## What to exercise

- migrations applied once, then an idempotent re-run returns `[]`
- every validator: valid, invalid, boundary (id shapes, `off` hours,
  `javascript:` URLs, SLA ranges, capacity ranges)
- callback roundtrip + the 64-byte encoder raising on overflow
- keyboards: colored styles present, copy-text payload correct, an empty role
  set returns `None` rather than raising
- tenant lifecycle: create (owner auto-member, settings seeded) → disable →
  enable
- verification: issue → wrong code rejected → right code consumed exactly
  once → second use rejected; full `start()` flow with `is_human` stubbed
- ticket lifecycle: create (auto-assign honours capacity) → agent reply
  (first-reply stamp, status → pending) → internal note invisible in the
  customer view → customer follow-up re-opens → priority → transfer → close →
  rating (a foreign user's rating refused) → reply-on-closed refused
- SLA: overdue fires once, does not double-fire, a new customer message
  re-arms it
- settings garbage fallback (non-numeric SLA → default, not a crash)
- customer search by tag and by numeric id; stats and reports render
- handlers: ctx build/enrich, customer text → ticket append, `/start` for the
  owner, callback dispatch, and **messages from other bots ignored**
- health: start the HTTP server on the test port, `urllib` GET `/health`,
  assert 200 + `db: true`, then shut the server down
- permissions: a lower role hitting an admin callback gets the denial message,
  not the action

## Reading failures

A FAIL in a flow you "already tested by eye" usually means the test encoded
the wrong expectation (e.g. asserting auto-assignment picked an agent when the
owner legitimately has the least load). Fix the expectation only after
confirming the implementation is the intended behaviour — never weaken an
assertion just to go green.
