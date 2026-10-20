# Platform (reseller) model: plans → accounts → shops

When the buyer is not one company but a platform sold to many companies, the
hierarchy is one layer taller than a normal helpdesk, and getting that layer
wrong is a redesign rather than a patch.

## The layer diagram to confirm before writing code

```
platform owner   sells plans; touches no tickets
   └─ account     paying customer, owns a customer panel
        └─ shop    (the tenant row) - staff, customers, ticket link, group
             └─ end user   taps the shop's link -> ticket goes to the shop only
```

Questions that decide the schema, ask them in one message:
- how many shops may one account own (a plan field, or always one)?
- who sets that limit — the platform owner at sale time, or self-serve?
- does the end user ever see the platform layer, or only the shop's branding?

This is the standard white-label/reseller shape (platform → reseller → tenant),
so its vocabulary is worth reusing: the tenant table is the shop; the account is
the reseller.

## Schema

Do not build a second tenant-like table. The existing `tenants` row keeps being
the shop; add the layer above it:

```sql
plans(id, name, max_shops, price, active, created_at)
accounts(id, tg_id, name, plan_id, status, verified_at, created_at)
ALTER TABLE tenants  ADD COLUMN account_id INTEGER REFERENCES accounts(id);
ALTER TABLE verify_codes ADD COLUMN account_id INTEGER;
```

`status` is `pending | active | disabled`, and `pending` is what a sale creates
until the buyer proves they own the Telegram id.

## Sale flow (owner side)

1. Owner taps "sell plan" → plan picker (one button per plan, showing its shop
   cap in the label so the choice is informed).
2. Owner sends the buyer's numeric id.
3. Server creates a `pending` account and messages the BUYER a 6-digit code.
   The buyer must have pressed Start at least once, or `bot.send` raises — say
   that in Persian instead of failing silently.
4. Buyer sends the code → account `active` → the customer panel is delivered
   immediately in the same message.

Refuse a duplicate sale for the same `tg_id` early; a second active account for
one user makes "which panel am I in" ambiguous everywhere.

## Customer panel (account side)

- Home screen: shops owned, plan name, usage as `used/cap`, and a create button.
- Enforce the cap server-side from the PLAN ROW, never from a number in the
  callback or the text the user typed; show the "plan limit reached" message
  with the cap in it so the upgrade path is obvious.
- Creating a shop calls the same creator as any tenant (`tenant_manager.create`
  with `account_id=`), which makes the buyer the shop's owner member and seeds
  its settings — reuse it instead of inserting a tenant by hand.
- Entering a shop sets `ctx["tenant_id"]` after an ownership check, plus
  staff/admin/owner flags, so the existing shop-scoped handlers work unchanged.
  A shop belonging to another account gets an explicit refusal.

## Self-service purchase (buyer never talks to the owner)

The same plans table also powers a shop window: the platform owner prices the
plans once, and strangers buy without being added by hand. Add one order table
and two platform settings; nothing about the account/shop layer changes.

```sql
orders(id, tg_id, plan_id, amount, status, receipt_file_id, receipt_type,
       account_id, created_at, reviewed_at, reviewed_by)
-- status: awaiting_receipt | pending | approved | rejected | cancelled
-- platform settings live in the SAME settings table at tenant_id = 0
-- (card_number, card_holder): no tenant owns them, so give them
-- plat_get/plat_set helpers rather than a second settings table.
```

Flow, with the amount fixed at order creation:

1. Buyer taps "buy" → one button per sellable plan, price IN the label.
2. Picking a plan inserts an order with `amount` copied from the plan row, then
   shows a payment screen: card printed as `<code>` text + a copy_text button.
3. "Send receipt" sets an FSM state; the handler accepts only a photo or a
   document (plain text gets a retry message, not a silent drop), stores the
   `file_id` + type, and flips the order to `pending`.
4. The owner is alerted with the receipt attached and two buttons
   (approve / reject). Approve creates or re-plans the account, marks it
   verified, and drops the buyer straight into the customer panel.

Rules that keep it honest:

- **Amount comes from the plan row, never from the buyer's message.** Price 0
  or an inactive plan means it is not listed and not buyable, so the "free"
  path cannot be reached by choosing weird input.
- **Ownership-check every order action** (`order["tg_id"] == ctx["tg_id"]`)
  for receipt upload and cancel; an approved order cannot be rejected.
- **A second buy from an already-active customer is refused** with a pointer to
  their panel, otherwise they end up with two panels' worth of state.
- **Surface the setup gaps in the owner's own screens**: a plans list that
  warns "no plan is priced" and "no card number set" saves a support round
  trip that would otherwise arrive as "nobody can buy" from a stranger.

## Entry routing

One entry point is enough, and the order matters:

```
/start → staff? shop menu
       → customer? customer menu
       → account holder (and not platform owner)? account panel
       → platform owner? owner menu (bootstrap the first tenant if none)
       → stranger? welcome + help
```

The account check must be skipped for the platform owner, otherwise the owner
loses the owner block the moment they also buy a plan themselves.

## Isolation checks the test must make

- tickets created in shop A never appear in shop B (`count_tickets(B) == 0`)
- an end user of shop A is not a customer of shop B
- entering another account's shop is refused
- cap is enforced exactly at the limit, and no FSM state is left behind
- the platform owner still sees their own `tenants` list after gaining an account
- a stranger sees the buy entry and an active account holder does not
- an approved order leaves exactly one active account, and a rejected one leaves none
- a photo receipt is stored as the LARGEST size, and a document receipt keeps
  its type so the owner gets `sendDocument` rather than `sendPhoto`
