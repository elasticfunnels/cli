---
name: ef-segql
description: >-
  Write, check and save ElasticFunnels audience segments in SegQL with `ef audiences`: buyers, upsell
  skippers, abandoned checkouts, repeat buyers, refunders, lapsed customers. Use for "build an audience",
  "segment", "who bought X".
---

# SegQL audiences with `ef audiences`

An audience is a saved SegQL query. The server recomputes it on a schedule; email and SMS campaigns send
to it (`ef campaigns ... --audience <id>`). This skill is the grammar as the server implements it today.
When in doubt, `ef audiences schema` prints the live contract (sources, columns, operators, profile fields,
functions) and wins over anything written here.

## The loop: validate, count, then save

1. Write the query in a file (`aud.segql`); quoting is easier than on the command line.
2. `ef audiences validate --file aud.segql`: parse + validate + compile, nothing runs. Fix any
   `SegQL parse error` / `SegQL validation error` it prints.
3. `ef audiences count --file aud.segql --sample 10`: how many people match now, plus a sample.
   **A wrong value is not an error, it is a silent 0.** If the count is 0 or looks off, check the values
   (event names, `type`, `sale_type`, product codes) before saving. Compare against a looser query.
4. `ef audiences create --name "Upsell skippers 30d" --file aud.segql`. It computes in the background;
   `ef audiences count <id>` shows the size once it has.
5. Change it later with `ef audiences update <id> --file aud.segql` (recomputes) or `--name`.

Samples and members come back masked (`j***@g***.com`, `***0123`, `J***`) when your key's user lacks the
"view contact PII" permission. That is expected; do not try to work around it.

## Shape

```
FROM <source>[, <source>...]
WHERE <condition> [AND|OR <condition> ...]
[WITHIN <n>d]
IDENTIFY BY <email|contact|customer|profile|person|device|session>
[ENRICH WITH customer("field", "field", ...)]
[COMPUTE <agg> <entity>(<column> [WHERE ...]) AS <alias>, ...]
[ORDER BY <field> ASC|DESC] [LIMIT n]
```

- **Sources:** `conversions`, `conversion_products`, `events`, `clicks`, `transactions`, `sessions`,
  `customers`, `quiz_answers`, `ad_spend`, `split_assignments`, and `contacts` on brands that use contacts.
- **Entities in conditions** are singular: `conversion(...)`, `event(...)`, `session(...)`, `click(...)`,
  `transaction(...)`, `order(...)` (one row per order, front end + upsells together), `contact(...)`.
- **WITHIN Nd** is the lookback window (each source filters on its own time column: conversions on
  `purchased_at`, events and clicks on `created_at`, sessions on `last_seen_at`). Without it the
  activity conditions look at all history. PROFILE values are lifetime totals, so a query made only of
  PROFILE conditions must not have `WITHIN` (the server rejects it); use `PROFILE last_purchase_at >=
  days_ago(90)` or put the window on an activity condition instead.
- **IDENTIFY BY** decides who a member is. For anything you will email or text, use `email` (or `contact`
  on contacts brands). `profile`/`person`/`device` are anonymous visitors; campaigns reach them only when
  the visitor is linked to a contact. `session` is a single visit and is never mailable.
- **ENRICH WITH** field names must be quoted strings: `ENRICH WITH customer("email", "total_orders")`.
  Enriched contact fields are masked without the PII permission.

## Conditions

| Form | Meaning |
|---|---|
| `HAS conversion(type = "purchase")` | at least one matching row in the window |
| `NOT HAS conversion(type = "refund")` | none |
| `COUNT order() >= 2` | number of orders (use `order`, not purchase rows: each upsell is its own row) |
| `COUNT event("page-view") >= 3` | number of matching rows |
| `SUM conversion(total WHERE type IN ("purchase", "refund")) >= 250` | sum of a column |
| `MAX order(total) >= 150` | largest order |
| `PROFILE total_orders >= 3` | per-person profile value, no window needed |
| `HAS conversion(type = "refund") AS r JOINED TO conversion(type = "purchase") AS p ON order_id WHERE days_between(p.purchased_at, r.created_at) <= 14` | two rows of the same order |

Inside `(...)`: `column op value`, joined with `AND` / `OR`. Events take the event name first:
`event("add-to-cart")`, `event("page-view" AND created_at >= hours_ago(6))`.

**Operators:** `=`, `!=`, `>`, `>=`, `<`, `<=`, `IN (...)`, `NOT IN (...)`, `CONTAINS`, `STARTS_WITH`,
`ENDS_WITH` and their `NOT` forms, `IS NULL`, `IS NOT NULL`. Contacts lists also take
`tags HAS "vip"`, `HAS ANY (...)`, `HAS ALL (...)`.

**Functions:** `days_ago(n)`, `hours_ago(n)` for relative times; `days_between(a, b)`, `hours_between`,
`minutes_between`, `seconds_between` inside a JOINED condition. Virtual columns `day_of_week`, `hour_of_day`.

## Values that exist (checked against prod data)

- `conversions.type`: `purchase`, `refund`, `chargeback`, `failed_payment`, and `abandon...` (use
  `type STARTS_WITH "abandon"`).
- `conversions.sale_type`: `main`, `upsell`, `downsell`, `bump`.
- `conversions.product_codes` is a list: `product_codes = "CODE"`, `product_codes IN ("A", "B")`,
  `product_codes CONTAINS "CODE"`.
- `conversions.refunder_org = 1` / `chargebacker_org = 1`: refunded or charged back at any brand of the org.
- Events: `page-view`, `buy-link`, `add-to-cart`, `checkout-loaded`, `video-play`, `video-showed-cta`,
  `upsell-link`, `upsell-decline`.
- `sessions.ad_platform`: `meta_ads`, `google_ads` (on sessions; conversions do not carry it).
- Quality flags on sessions: `is_bot`, `is_hosting`, `is_proxy`, `is_vpn`, `is_automation`, `is_test`.

## PROFILE fields

Numbers and dates: `total_orders`, `total_revenue` (= `lifetime_value`), `avg_order_value`,
`avg_days_between_orders`, `days_since_last_order`, `overdue_ratio` (days since last order / usual gap),
`last_gap_ratio`, `first_purchase_at`, `last_purchase_at`, `last_seen_at`, `refund_total`, `refund_count`,
`chargeback_count`, `is_refunder`, `is_chargebacker`, `last_refund_at`, `last_chargeback_at`.

Text: `acquisition_utm_source`, `acquisition_utm_medium`, `acquisition_utm_campaign`,
`acquisition_ad_platform`, `status`, `subscription_status`, `country_code`, `region`, `city`.

**PII fields:** `email`, `first_name`, `last_name`, `customer_name`, `phone`, `zip` (plus `city`, `region`)
can be filtered (`PROFILE email ENDS_WITH "@gmail.com"`) but are contact data. Only filter on them when the
task needs it, and never print member lists with them into chat or files beyond what the user asked for.

## DTC examples

Buyers who skipped every upsell (last 30 days):
```
FROM conversions WHERE HAS conversion(type = "purchase" AND sale_type = "main")
  AND NOT HAS conversion(type = "purchase" AND sale_type IN ("upsell", "downsell", "bump"))
  WITHIN 30d IDENTIFY BY email
```

Abandoned checkout in the last 7 days, never bought:
```
FROM conversions WHERE HAS conversion(type STARTS_WITH "abandon") AND NOT HAS conversion(type = "purchase")
  WITHIN 7d IDENTIFY BY email
```

Repeat buyers (2+ orders in a year), with what they bought:
```
FROM conversions WHERE COUNT order() >= 2 WITHIN 365d IDENTIFY BY email
  COMPUTE LIST conversion(product_codes WHERE type = "purchase") AS products
```

Refunded in the last 90 days:
```
FROM conversions WHERE HAS conversion(type = "refund") WITHIN 90d IDENTIFY BY email
```

Bought product X but not Y:
```
FROM conversions WHERE HAS conversion(type = "purchase" AND product_codes = "X")
  AND NOT HAS conversion(type = "purchase" AND product_codes = "Y") WITHIN 180d IDENTIFY BY email
```

Lapsed big spenders (no refunds):
```
FROM conversions WHERE PROFILE lifetime_value >= 300 AND PROFILE days_since_last_order >= 60
  AND PROFILE days_since_last_order < 180 AND PROFILE refund_count = 0 IDENTIFY BY email
```

Due to reorder (3+ orders, past their usual gap):
```
FROM conversions WHERE PROFILE total_orders >= 3 AND PROFILE overdue_ratio >= 0.9
  AND PROFILE overdue_ratio < 1.3 IDENTIFY BY email
```

## Traps

- Count orders with `COUNT order()`, not `COUNT conversion(type = "purchase")`: an upsell is a separate
  purchase row, so row counts call every upsell taker a repeat buyer.
- Refunds are rows of `type = "refund"`; a refunder can still match `HAS conversion(type = "purchase")`.
  Exclude them explicitly when it matters.
- Leave refunders and chargebacks out of promotional audiences unless the task says otherwise.
- `ef audiences delete` removes the audience a campaign may be using; check `ef campaigns email list` first.
