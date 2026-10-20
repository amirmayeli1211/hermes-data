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
- The `bot.api` stub must also handle the media methods (`sendPhoto`,
  `sendDocument`) by recording `(chat_id, method, file_id, caption, keyboard)`
  into a separate list. Otherwise a receipt that never left the process still
  looks delivered to a text-only assertion. Build the fixture updates the way
  Telegram does: photo sizes ascending in the list, each entry carrying
  `file_size` — a fixture without sizes exercises a code path that production
  never hits.
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
- **every role's menu, with EVERY callback on it routed** — iterate
  `callback_data` off the sent keyboard and tap each one, collecting the ones
  that raise. A dead button is invisible to a flow test; this is the check
  that catches it, and it covers roles the author forgot to write a flow for.
  (A callback scheme mixing id-first `<ns>:<id>:<op>` with op-first
  `<ns>:<op>[:<arg>]` needs the digit test: `args[0].isdigit()` decides which
  parse applies.)
- platform layer, when the product has one: sale → pending account → code →
  active → panel; plan cap enforced at the limit AND one past it; a shop owned
  by another account refused; tickets not leaking across shops
- self-service purchase, when plans are sold: price/card validators (spaces
  and dashes tolerated, 15 digits rejected, price 0 means "not for sale");
  buy → order amount equals the PLAN price even when the user typed a number;
  text instead of an image refused and the order stays `awaiting_receipt`;
  photo and document receipts both reach the owner with the right method;
  approve creates exactly one active account and lands the buyer on the panel;
  reject leaves no account; another user's order cannot be receipted or
  cancelled; an approved order cannot be rejected; a zero-priced or disabled
  plan is absent from the buy list and refused by direct callback
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

A stub that always succeeds hides real routing bugs. Model the failure the
real API produces: keep a `NEVER_STARTED` set of chat ids that the send stub
refuses, so "the customer never pressed Start" is exercised, and assert the
fallback (threaded group reply) fired.

To debug a puzzling FAIL, replay the flow in a throwaway script that PRINTS
the FSM state row and the last sent text after each step. The state row
reveals a stale or missing state that a message-level assertion cannot — and
a missing plan/limit join shows up as `None` there before it becomes a wrong
product limit elsewhere.

When a check fails on something "that was just written", check whether the
handler is reading a row it loaded BEFORE its own write (e.g. a notifier using
the order dict captured before the receipt was attached). Print the row at the
notification site; if the new field is still `None`, the fix is a re-read, not
a new assertion.
