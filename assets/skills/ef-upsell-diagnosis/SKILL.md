---
name: ef-upsell-diagnosis
description: >-
  Diagnose why an ElasticFunnels funnel's upsell / downsell take is low and
  what to change — offer-to-buyer mismatch, price objections revealed by the
  downsell, buyers routed past the upsells, dead late steps, split tests that
  cannot finish — and, when the user decides, end an upsell split test on its
  winner with `ef splits winner`. Use whenever someone says "upsell CVR is too
  low", "upsell take rate", "nobody buys upsell 1", "why is AOV flat", "should
  the downsell be the upsell", "which upsell should we cut", "fix the OTO",
  "set <variant> as the winner", or asks what to test next on a post-purchase
  page. Start from the step table built by the `ef-funnel-analysis` skill;
  build it first if you don't have it.
---

# Upsell diagnosis

The input is the **step table** from `ef-funnel-analysis`: every post-purchase
page, the page it follows, its offer and price, sessions and sales. Don't
diagnose from `upsell_take_pct` alone. That one number can't show *which*
step is the problem.

Read-only until the last section. Recommend; don't change pages, prices or
graphs without the user asking.

---

## The diagnostic questions, in order

Work through them in this order. The earlier ones cost more and are cheaper to
fix.

### 1. Do buyers even reach the upsell? (routing)

Low sessions on an upsell page after a front end is **not** evidence by itself
— post-checkout pages undercount sessions badly. Check with orders: build the
per-buyer table (`ef-funnel-analysis`, "Per-buyer take") and compare the share
of each front end's buyers who bought any post-purchase offer. Only a front
end whose buyers take ~nothing, against a normal rate elsewhere, has a routing
leak. Then fix routing before touching copy or price.

### 2. Does the upsell fit what they just paid? (package and price)

Read the funnel graph (`ef funnels pull <code>`, then the `router` /
`product_check` nodes) to see what each package is actually offered — do not
assume. Then use the per-buyer table to measure take **per front-end product
code and price**.

- **Don't assume "more of the same" fails for max-package buyers.** Measured on
  one funnel, buyers of 6 bottles at full price took "6 more" at the *highest*
  rate (~24%), 3-bottle buyers ~12%, and 1–2-bottle buyers ~0%. Big-package
  buyers are the committed ones. Keep the same-product upsell for them unless
  their measured take says otherwise.
- **Price-anchor mismatch is the common real failure.** A front end sold at a
  steep discount (6 bottles at $96) followed by the standard upsell (6 more at
  $234) took 0 of 17: the upsell costs 2.4× what they just paid for the same
  thing. Discounted front ends need their own price-matched upsell.
- Small-package buyers who take nothing: test a smaller, cheaper top-up rather
  than jumping them to the biggest package.

### 3. Does the downsell beat the upsell? (price objection)

If the downsell converts clearly better per session than the upsell it
replaces (e.g. 12.5% on 3 bottles at $117 vs ~5% on 6 bottles at $234), then
buyers want the product and are refusing the **price**. Report it that way. It
points to a cheaper upsell 1, or to leading with the downsell's price point.

Look in `ef products list --json` for cheaper variants of the upsell product
that already exist (e.g. `_discount_max`, `_67off`). Also check whether some
front ends are routed to them and others aren't — a cheaper upsell that exists
on only one path is a quick win.

### 4. Which steps are dead?

A late step with plenty of sessions and ~0 sales (70 sessions → 1 sale) costs
the buyer's patience and earns nothing, and every later step suffers for it.
Compare its price with the funnel's front-end prices. A third-step offer
priced like the main product ($234 skincare after a $294 order) is usually
why. Recommend cutting it or repricing it, and give the revenue it actually
made in the period.

### 5. Is an upsell split test ever going to finish?

`ef stats splits` → any test whose TARGET is a flow page →
`ef stats split <id> --range 30d`. Read `winner` exactly as the `ef-stats`
skill says: **never derive a winner yourself**. Then estimate how long until
the sample floor, from the needed sessions per arm and the current traffic
per arm. If that is several months, the test will not produce an answer in
any useful time. Say so, give the trend with its p-value, label it "trending,
not conclusive", and leave the decision to the user.

Read the test's entry in `elasticfunnels/split-tests.md` first. If there is
none, say the hypothesis was never recorded — don't invent one.

---

## Declaring a winner (only when the user decides)

A manual winner is a business call, and it is the user's to make. Once they
have made it:

```bash
ef splits variants <id>                     # variant names ↔ node codes
ef splits winner <id> "<variant name>"      # or the node code; add --yes off a terminal
```

- This finalizes the test **and writes the winner into the page/funnel
  graph**, so all traffic goes to that arm. (The dashboard's older
  declare-winner route only marked the test row as finalized and left the
  graph splitting; the CLI deliberately uses the endpoint that writes both.)
- It prints the server's verdict first. When the server named no winner, it
  warns that this is a manual call — relay that to the user; don't hide it.
- Afterwards: `ef stats splits` should show `finalized`, and the graph has
  changed on the server, so pull it before editing it
  (`ef pages events pull <slug>` / `ef funnels pull <code>`).
- Append to `elasticfunnels/split-tests.md` under the test id: the date, the
  winning arm and its node code, the per-arm numbers with the range and
  timezone, the server's verdict at the time, and that the call was manual.

---

## What a good answer looks like

1. One line: the take rate (server's `upsell_take_pct`) and the step that is
   costing the most.
2. The step table: front end → upsell 1 → downsell → upsell 2 → …, with
   offer, price, sessions, sales, take.
3. The reasons, each tied to a number from the table (routing, same product,
   price, dead step, a split test that won't finish).
4. Two or three concrete changes, ordered by money at stake. Offer to open the
   pages to review their copy. Don't recommend copy changes you haven't
   read.
