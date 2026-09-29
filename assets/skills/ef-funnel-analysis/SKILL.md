---
name: ef-funnel-analysis
description: >-
  Map an ElasticFunnels funnel end to end and measure every step — which funnel
  sells, which front-end page converts, how buyers move through upsells and
  downsells, and where they drop out. Joins the compiled product flow
  (`ef funnels product-flow`) with per-page and per-product stats
  (`ef stats by page|product --funnel`) and prices (`ef products list`) into
  one step table. Use whenever someone asks "sales by funnel", "show me the
  <name> funnel", "how do people buy", "walk me through the funnel", "where do
  buyers drop off", "which front end converts best", "what's the take rate on
  upsell 1", "is anyone seeing the upsells", or before diagnosing a weak upsell
  (then continue with the `ef-upsell-diagnosis` skill). Builds on `ef-stats` —
  its timezone / unavailable-metric / split-test rules all still apply.
---

# Funnel analysis

Two questions, answered in this order:

1. **Which funnel is making the money?** — `ef stats by funnel_id`.
2. **How do buyers move through that funnel?** — the step table: every page in
   the funnel's product flow, with its offer, price, sessions and sales, in the
   order a buyer meets them.

Everything here is read-only. Changing a funnel is `ef funnels` /
`ef pages events` (the `ef-page-events` skill); ending a split test is
`ef splits winner`.

The `ef-stats` rules still apply: say which date range and timezone the numbers
cover, report a missing metric as unavailable (not as zero), and never compute
your own significance. Check `ef config get` for `analyticsTz`. If it is empty,
the CLI uses this machine's timezone. Say so in the report.

---

## Step 1 — sales by funnel

```bash
ef stats by funnel_id --metrics sales,revenue,main_sales,upsell_sales,sessions,conversion_rate,aov --range 30d
ef stats by funnel_id --metrics sales --range 30d --json | jq -c '.rows[] | {label, key}'   # funnel ids
```

The row `key` is the funnel id — the id that `--funnel <id>` and
`ef funnels product-flow <id>` take. `ef funnels list` maps ids to codes and
titles.

How to read it:

- **`(unlabeled)` / blank row** — orders with no funnel attribution. Report it
  as unattributed revenue, not as a funnel. If it is large, that is its own
  finding: the funnel report does not account for that revenue.
- **Conversion rate far above normal (40%, >100%)** — sales that did not come
  through a tracked session on these pages (affiliate direct links, off-site
  checkouts, reorders). Compare such a funnel on sales and revenue, never on
  its conversion rate.
- **`sales` ≠ `main_sales + upsell_sales`.** The difference is bumps and
  add-ons (e.g. shipping insurance), which count as sales but are neither main
  nor upsell. Don't make the columns "add up" by guessing.
- Funnels with a handful of sessions and zero sales are not failures, they are
  unlaunched. Group them into one line.
- **The dashboard's funnel hover card ("Visitors / Conv.") is not comparable.**
  It counts every distinct `session_id` on the clicks store, which includes
  tracking-link hits that never loaded a page. It can run 10–75× the
  `sessions` metric (seen: DF 39.6k "visitors" vs 534 sessions → 0.07% vs
  3.56%). Quote `ef stats` sessions and conversion rate. If someone brings the
  card's rate, reconcile it against these numbers; don't explain it away.

---

## Step 2 — the funnel's structure

```bash
ef funnels product-flow <funnelId>        # prints JSON; it has no --json flag (passing one errors)
```

Each entry of `.product_flow` is one buy link on one page:

| field | meaning |
| --- | --- |
| `page_id` | the page the link is on — joins to `ef stats by page` row `key` |
| `classification` | `main` (front end) or `upsell` (anything after the first purchase, downsells included) |
| `product_code` | joins to `ef products list --json` `.code` for the price |
| `purchase_node_code` | the purchase step this link completes |
| `previous_purchase_node_code` | the purchase a buyer must have made to reach this page |

**Rebuild the step order from the node chain, not from `upsell_number`.** The
compiled flow commonly labels every post-purchase page `upsell_number: 1`. The
real order is the chain: a page whose `previous_purchase_node_code` is a main
page's `purchase_node_code` is upsell 1; a page following *that* page's
`purchase_node_code` is upsell 2, and so on. Two pages sharing the same
previous node are **alternatives at the same depth** — usually upsell 1 and its
downsell, or two routes for different front ends.

**Different front ends can have different upsell paths.** Front-end pages carry
different `purchase_node_code`s. Each code has its own list of pages that
follow it. Always check which upsell each front end leads to (see "the
routing-leak check" below).

---

## Step 3 — the step table

This one pipeline joins structure, traffic and price. It was tested against a
live funnel — re-use it rather than re-deriving it:

```bash
F=<funnelId>; R=30d; T=$(mktemp -d)
ef funnels product-flow $F > $T/flow.json
ef stats by page --funnel $F --metrics sessions,sales,main_sales,upsell_sales,revenue --range $R --limit 500 --json > $T/pages.json
ef products list --json > $T/products.json
jq -r --slurpfile st $T/pages.json --slurpfile pr $T/products.json '
  ($st[0].rows | map({key: (.key|tostring), value: .}) | from_entries) as $s
  | ($pr[0] | map({key: .code, value: .price}) | from_entries) as $p
  | [.product_flow[]] | group_by(.page_id)
  | map({page: .[0].page_id, cls: .[0].classification,
         node: .[0].purchase_node_code, after: (.[0].previous_purchase_node_code // "-"),
         offers: (map("\(.product_code)=$\($p[.product_code] // "?")") | unique | join(" ")),
         name: ($s[(.[0].page_id|tostring)].label // "(no traffic)"),
         sess: ($s[(.[0].page_id|tostring)].metrics.sessions // 0),
         sales: ($s[(.[0].page_id|tostring)].metrics.sales // 0)})
  | sort_by(.cls != "main", .sess * -1)[]
  | [.cls, .page, .name, .sess, .sales,
     (if .sess > 0 then (.sales*1000/.sess|round/10|tostring)+"%" else "-" end),
     .node, .after, .offers] | @tsv' $T/flow.json | column -t -s $'\t'
```

Columns: class, page id, page name, sessions, sales, sales/session, this
page's purchase node, the node it follows, offers with prices.

Then add per-product detail:

```bash
ef stats by product --funnel $F --metrics sales,revenue --range $R --limit 100
ef stats --funnel $F --metrics sales,main_sales,upsell_sales,upsell_take_pct,main_revenue,upsell_revenue,aov --range $R
```

`upsell_take_pct` is the server's own headline take rate. Quote it, and don't
recompute it from the table.

### Pages in `by page` that are not in the flow

`ef stats by page --funnel` also lists pages that have no buy links (members
area, contact, legal) and **split-test variants** of flow pages (e.g. "Upsell 1
- Loader V3" alongside "Upsell 1 - Loader"). A page with real sessions and
sales but no `product_flow` entry is usually a variant. Confirm with
`ef stats splits` (the TARGET column), and add its numbers to its parent step
rather than dropping them.

---

## Checks to run on every step table

Present the table as a funnel, in buyer order: front end → upsell 1 →
downsell → upsell 2 → … Group each step's variant pages together. Then run:

1. **The routing-leak check — confirm with orders, never with sessions alone.**
   Upsell-page sessions are badly undercounted: post-checkout pages often
   record a handful of sessions while taking many orders (seen: 3 sessions →
   14 sales; a front end with 46 sales whose upsell page showed 4 sessions,
   yet its buyers bought upsells at the same rate as every other front end).
   So low upsell sessions after a front end is a **question, not a finding**.
   Answer it with the per-buyer table ("Per-buyer take" below): if that
   front end's buyers bought post-purchase offers at roughly the funnel's
   rate, there is no leak; if they bought ~none, it is a real leak (checkout
   return URL, merchant thank-you page, broken redirect, page event). Only
   then flag it.
2. **Sessions vs buyers.** Upsell sessions can exceed the buyers who reached
   them (reloads, back-button, repeat visits), so sales ÷ sessions
   *understates* the take per buyer. Say which one you are quoting. The
   ranking between steps is still valid.
3. **Front-end conversion by page.** Sales ÷ sessions per main page. A
   high-traffic page converting at a fraction of the others is where front-end
   money is lost — report it even if the question was about upsells.
4. **Dead steps.** A late step with plenty of sessions and ~0 sales (e.g. 70
   sessions → 1 sale) costs the buyer's attention and earns nothing.
5. **Running split tests on funnel pages.** `ef stats splits`, then
   `ef stats split <id>` for any that target a flow page. Read the verdict as
   the `ef-stats` skill says. If one is trending but will need months at the
   current traffic to reach the sample floor, say so plainly: waiting for it
   will not produce an answer. Whether to call it is the user's decision.
   Before reporting on a test, read that test's entry in
   `elasticfunnels/split-tests.md`.

---

## Per-buyer take (orders, not sessions)

The step table cannot tell you *who* took an upsell. For "which buyers take
the upsell" — by front-end package, price or page — use:

```bash
ef orders buyers --funnel <id> --range 30d            # per front-end product code, list vs median paid
ef orders buyers --funnel <id> --range 30d --by page  # per first page
```

Report take per front-end **product code and price**, not just per bottle
count — a discounted front end behaves nothing like the same bottle count at
full price. Bumps are excluded automatically. Samples are small — give the n
next to every rate. Trace individual buyers with `ef sessions show <id>`.

## Reporting

- Lead with the one number that answers the question, then the step table.
- Per step: offer, price, sessions, sales, take. Keep revenue per step for
  the summary line.
- Name findings by consequence ("most buyers from the advertorial never see an
  upsell"), not by mechanism ("node tm49aj has few downstream sessions").
- If the question is "the upsell take is too low", hand over to the
  `ef-upsell-diagnosis` skill with this table as its input.
