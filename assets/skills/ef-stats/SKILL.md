---
name: ef-stats
description: >-
  Read and interpret ElasticFunnels analytics with the `ef stats` CLI — revenue,
  sessions, conversion rate, EPC, ad spend, profit, refunds, upsell take, plus
  per-page / per-country / per-UTM / per-day breakdowns and split-test results.
  Use whenever a task means answering how something *performed* rather than
  changing it: "how did we do last week", "what's revenue this month", "which
  page converts best", "where is traffic coming from", "is the split test a
  winner yet", "did the new headline help", "what's our EPC / AOV / CPA",
  "compare this month to last", "which country buys most", "why did sales
  drop". Also use before declaring any A/B test result, and before quoting a
  number to someone.
---

# ElasticFunnels analytics (`ef stats`)

`ef stats` reads the same analytics API the web dashboard uses, through the
project's own per-brand credential. Two consequences worth holding onto:

- **It is read-only.** Nothing here changes a page, a test, or a setting.
- **It is scoped to this brand.** The key in `.ef/auth` opens exactly one brand,
  so these numbers are always *this* project's. There is no account-wide
  roll-up to ask for, and pointing it at another brand returns 401.

```
ef stats                                  # headline metrics, last 7 days
ef stats metrics                          # what THIS brand can report on
ef stats fields                           # what you can break down by
ef stats by <field>                       # the breakdown
ef stats splits                           # list split tests
ef stats split <id>                       # one test + significance verdict
```

Every command takes `--json`. Use it whenever you are going to compute with the
numbers rather than read them.

---

## The four things that will bite you

These are not style preferences. Each one produces a confidently wrong answer
with nothing in the output to warn you.

### 1. Days are counted in a timezone, and the default is not this brand's

The API buckets by calendar day, and when no timezone is supplied it falls back
to **`America/Los_Angeles`** — not to the brand's own zone. For a brand outside
that offset, every day boundary silently shifts.

The CLI always sends a zone, defaulting to the machine's. That is right often
enough to be dangerous: **your machine is not necessarily the brand's market.**

```
ef stats --range yesterday --tz America/New_York     # per run
ef config set analyticsTz America/New_York           # once, per project
```

> A drop or spike that appears when nobody changed anything — especially at the
> edge of a range, or on a single-day query — is a boundary shift until proven
> otherwise. Re-run it with an explicit `--tz` before reporting it as real.

### 2. Metric keys are per-brand — discover, do not assume

The registry is assembled **server-side per request** from the brand's plan
modules and the caller's role permissions. Two brands on the same release
legitimately expose different metrics. There is no fixed list to memorise.

```
ef stats metrics                    # everything this brand has, grouped
ef stats metrics --group Revenue    # one group
ef stats metrics --json | jq -r '.metrics[].type'
```

A key that is missing comes back as **unavailable**, which is *not* zero. The
CLI says so explicitly:

```
Not available for this brand: cogs, ad_spend. "ef stats metrics" lists what is.
```

Report that as "this brand does not track it", never as "it was 0".

### 3. A response can contain metrics you did not ask for

The server resolves dependencies: ask for `conversion_rate` and it also
computes `sessions` and `customers`, because the rate is derived from them.

`ef stats` reports back **your selection, in your order**, and hides the rest.
If you want everything the server actually returned, use `--raw`. Do not treat
`--raw` extras as things you requested.

### 4. Never recompute a split test's significance

`ef stats split <id>` reports the **server's** verdict. The backend corrects
alpha for the number of arms and refuses to name a winner until every arm
clears a power-based minimum sample size — the guard against calling a test
early, which is the classic A/B false positive.

Running your own two-proportion z-test on the variant numbers will eventually
disagree with the dashboard, and then someone ships the losing variant.

**Read `winner`. Do not derive it.**

---

## Reading a metric value

```
$ ef stats --metrics revenue,sessions --range 30d
last 30 days (2026-07-21 → 2026-08-19, Europe/Bucharest)
METRIC    VALUE       CHANGE    VS
--------  ----------  --------  ------------------
revenue   $7,051.06   +29.11%   vs Jun 21 - Jul 20
sessions  4,203       -8.25%    vs Jun 21 - Jul 20
```

- **`VALUE`** is the server's own formatting — currency symbol, percent sign,
  separators. Quote it as-is so the CLI and the dashboard never disagree about
  what a number looks like.
- **`VS`** names the comparison window. It is the **immediately preceding
  period of the same length**, not year-over-year. A 30-day range compares to
  the 30 days before it. Never describe it as "vs last year".
- **Direction is per-metric.** Cost metrics carry `lower_is_better`, so a
  **+40% rise in `commissions_paid` is a loss, not a win.** The human output
  colours this correctly; in `--json`, check the metric's meaning before
  calling a rise good.

**Zero is not the same as no data.** `revenue $0.00` alongside `sessions 47`
means traffic that did not buy — a real, reportable finding. `sessions 0` means
nothing was tracked at all, which more often points at a broken range, the
wrong timezone, or a page that is not live yet.

---

## Breakdowns

```
ef stats fields                                          # what's groupable
ef stats by page    --metrics revenue,sessions --limit 10
ef stats by country --metrics sessions --range 30d
ef stats by day     --metrics revenue --range 14d        # a time series
ef stats by utm_source --metrics sessions --sort sessions
```

Dimensions cover time (`day`, `week`, `month`, `hour_of_day`), business
(`page`, `product`, `funnel_id`, `aff_id`, `subid`, `merchant_id`), geography
(`country`, `region`, `shipping_country`), tech (`device`, `os`, `browser`),
marketing (`utm_*`, `referrer`, `traffic_source`), behaviour and commerce.
`ef stats fields` is the authority for what this brand has.

Three things to know when reading the output:

- **Ordering.** Time dimensions come back in time order; everything else is
  sorted biggest-first by the first metric (override with `--sort <metric>`).
- **`--limit` truncates, and says so** (`10 of 46 rows`). If you are summing or
  concluding "most of our traffic is X", read the row count first — you may be
  looking at the top slice of a long tail.
- **The blank / `0` bucket is unattributed traffic**, not a bug. On
  `utm_source` it is direct and untagged visits, and it is frequently the
  largest row. Call it "direct / untagged", not "unknown source".

---

## Split tests

```
ef stats splits                    # id, name, type, status, target, views
ef stats split 321                 # per-variant metrics + verdict
ef stats split 321 --metrics sessions,conversion_rate,revenue,aov --range 30d
```

The verdict block is the point:

```
p-value  0.0310   power 82.0%
No winner yet — each arm needs ~1500 sessions before a call can be made.
```

How to report it:

- **`winner` is set** → that variant won. Say so, with the p-value.
- **`winner` is null but p-value looks significant** → **not a winner.** The
  sample floor has not been met. A low p-value on small samples is exactly what
  peeking-too-early looks like. Report it as "trending, not conclusive", and
  quote the remaining sample needed.
- **`(control)`** marks the baseline arm in the variant table. Lift is always
  relative to it.

Never recommend declaring a winner the server has not declared. If someone asks
you to call it early, say what the server says and let them decide.

### Variant labels like `j:null` or blank mean a missing `node_code`

If `ef stats split <id>` shows arms named `j:null`, `` or `(unlabeled)` rather
than the names configured on the test, the numbers are real and the *labels*
are what broke: the graph's nodes have no `node_code`, so analytics has no key
to map a variant back to its name.

That is a graph problem, not a stats problem — see the `ef-page-events` skill.
Say so plainly rather than reporting the raw keys as if they were variant
names, and do not try to guess which arm is which from the ordering.

### Read the project's own record first

`elasticfunnels/split-tests.md`, when it exists, is where this project writes
down what each test was *for*: the hypothesis, which arm is the control, and
what winning would mean. The server has none of that — it has variant keys and
numbers.

Read it before reporting on a test. It is the difference between "variant B is
at 3.1%" and "the listicle opener beat the self-assessment control, which is
what we predicted". If a test you are asked about has no entry, say so rather
than inventing the intent.

When a winner is declared, add the date and the deciding number to that test's
entry — the file is append-only history, not a status board.

---

## Scripting and reporting

`--json` on every command. The summary shape is deliberately slim:

```bash
ef stats --metrics revenue,sessions --range 30d --json
```
```json
{
  "ok": true,
  "brand_id": 317,
  "range": { "start": "2026-07-21", "end": "2026-08-19", "tz": "Europe/Bucharest" },
  "metrics": [
    { "metric": "revenue", "value": 7051.06, "formatted": "$7,051.06",
      "change_percent": 29.11, "previous_value": 5461.32, "vs": "vs previous month" }
  ],
  "unavailable": []
}
```

Useful shapes:

```bash
ef stats --json | jq -r '.metrics[] | "\(.metric)\t\(.formatted)"'
ef stats by country --metrics revenue --json | jq -r '.rows[] | "\(.label) \(.metrics.revenue)"'
ef stats metrics --json | jq -r '.metrics[] | select(.group_name=="Revenue & Sales") | .type'
```

**Always echo the range and timezone you used** when reporting a number to
someone. A figure without its window and zone is not reproducible, and it is
the single easiest way for two people to "both be right" about different
numbers.

---

## Ranges

```
--range today | yesterday | 7d | 14d | 30d | 90d | mtd | qtd | ytd | <n>d
--from 2026-08-01 --to 2026-08-18
```

`7d` means **today plus the six before it** — seven buckets, matching the
dashboard's "Last 7 days". `--from`/`--to` are inclusive, and cannot be
combined with `--range`.

---

## Scope filters

Stack these on any stats command to narrow the population:

```
--page <id>          --funnel <id>          --split-test <id>       --aff <id>
```

`--page` takes a page **id**, not a slug (`ef list pages` has them).

Scope filters narrow the *population*. They do not tell you whether a given
number can be narrowed that way — that is what the card catalog below answers.

---

## Dashboard cards, and where a card can resolve

`ef stats cards` lists the tiles the web dashboard can show, and — the useful
part — the report scopes each one **resolves** in.

```
ef stats cards                          # the whole catalog, with each card's scopes
ef stats cards --scope page             # only what a page report can answer
ef stats cards --scope split_test
ef stats cards --category traffic       # one registry family
ef stats cards --json | jq -r '.cards[] | select(.scopes[] == "funnel") | .key'
```

A card missing a scope is not a styling detail. It means **its data source
ignores that filter**: `sub_mrr_trend` accepts no page, funnel or split-test
parameter at all, so on a page report it would answer with the brand's MRR under
that page's heading — data, not a visible error. The catalog is where that fact
is written down; the scope names come back in the response, so an unknown one is
answered with the real list rather than a bare rejection.

Two things this is not:

- **Not a renderer.** The CLI lists cards; it does not draw them. For numbers in
  the terminal use `ef stats` and `ef stats by <field>`, which cover the top-N
  cards (`by product`, `by page`, `by country`, `by utm_source`) through one
  uniform endpoint.
- **Not the metric registry.** `ef stats metrics` answers "what can I measure",
  `ef stats cards` answers "what can I put on a report, and where". Cards whose
  integration this brand has not connected, and whose metric this key may not
  read, are already gone from the list.

---

## Do not

- Do not quote a number without its range and timezone.
- Do not report an unavailable metric as `0`.
- Do not compute your own significance, lift-confidence, or winner.
- Do not describe the comparison as year-over-year — it is the preceding period.
- Do not call a rise in a cost metric an improvement.
- Do not conclude from a `--limit`ed table without checking the row count.
- Do not use `ef stats` to change anything — it has no write path, by design.
