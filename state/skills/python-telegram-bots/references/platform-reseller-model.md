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
