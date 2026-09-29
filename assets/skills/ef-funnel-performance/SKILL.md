---
name: ef-funnel-performance
description: >-
  End-to-end playbook for analyzing an ElasticFunnels brand's funnel
  performance with Claude Code — decide what is worth fixing and prove it.
  Validates the data first (bots on home IPs, tracking gaps, dashboard/API
  traps), ranks funnels and affiliates by money (revenue, AOV split main vs
  upsell, refunds, estimated profit), reads the funnel graph correctly
  (page groups, purchase/decline, router, product checks — and that checkout
  pages are NOT graph steps), measures upsell take per buyer from orders,
  traces individual sessions to confirm a finding, and writes a developer
  brief with links. Use whenever someone asks "how are my funnels doing",
  "where should we optimize", "analyze the <name> funnel", "which affiliate
  is worth it", "what's the profit / AOV on <affiliate>", "why is CR so low",
  "is this traffic real", "write this up for a dev". Hands off to
  `ef-funnel-analysis` (step table) and `ef-upsell-diagnosis` (upsell fixes);
  all `ef-stats` rules apply.
---

# Funnel performance analysis

The job is to find **where money is being lost, prove it, and say what to
change** — in that order of rigor. Most wrong answers in this domain come from
trusting a number that measures something other than what its label says, so
the data is validated *before* anything is concluded.

Read-only throughout. Changes go through `ef funnels` / `ef pages events`
(`ef-page-events` skill) and only when the user asks; `ef splits winner` only
on the user's call.

---

## 0. Setup

```bash
ef status                          # right brand? last pull?
ef config get | grep analyticsTz   # empty → machine timezone; say so in every report
ef stats metrics | head -50        # which metrics this brand has (per-brand)
```

Orders, buyers, sessions and page details have their own commands (read-only;
all take `--range`/`--from`/`--to`/`--tz` and `--json`):

```bash
ef orders list --funnel <id> [--aff <id>] [--page <id>] [--type purchase|refund] --range 30d [--all]
ef orders buyers --funnel <id> [--aff <id>] [--by product|page] --range 30d   # per-buyer upsell take (§4)
ef sessions list --funnel <id> [--aff <id>] [--page <id>] [--exclude-bots] --range 7d   # one row per page load
ef sessions show <session_id> [--full-urls] [--all-events]   # visit summary, path, timeline, TRACKING GAP flags
ef pages get <idOrSlug>                                       # any page, incl. legacy/builder ones
ef list pages --all                                           # every page type (default lists editor pages only)
```

If the installed CLI predates these (`ef orders --help` errors), run
`ef update --check` and tell the user — don't hand-roll API calls.

`ef orders` strips customer PII unless `--include-pii` is passed. Don't pass
it; the buyer grouping never needs it. Put working files in the user's scratchpad, not the
repo.

Links for reports (brand id from `.ef/config.json`):

- funnel: `https://app.elasticfunnels.io/<brand>/funnels/<id>/builder` (also `/flow`, `/analytics`)
- orders: `https://app.elasticfunnels.io/<brand>/conversions?filter[funnel_id]=<id>`
- sessions: `https://app.elasticfunnels.io/<brand>/clicks?filter[funnel_id]=<id>`
- one session: `https://app.elasticfunnels.io/<brand>/clicks/session?id=<session_id>`
- split test: `https://app.elasticfunnels.io/<brand>/split-tests/<id>`

---

## 1. Validate the data before believing it

Run these checks first; each one has produced a confidently wrong conclusion
before.

| Trap | How to spot it | What to do |
|---|---|---|
| **Bots on residential IPs** (not flagged `is_bot`/`is_hosting`) | An affiliate with hundreds of sessions and ~0 sales; click rows with stale UA versions for the date (e.g. Chrome 123/124, iOS 17 in late 2026), `GoogleImageProxy`/link-scanner UAs, unfilled macros (`subid={gclid}`), one-shot subids | `ef stats by aff_id --funnel <id>`; sample rows with `ef sessions list --aff <id> --funnel <id>`. Report CR **with and without** the junk sources — a page can look terrible only because junk lands on it |
| **"Bot" verdicts from a sample** | A source with 0 sales and odd-looking click rows | Separate sessions that never loaded the page (scanners/bots, already excluded) from sessions with page-views. Check the page-view sessions for engagement events, time to page-view (~1 s for humans) and current UAs before calling them bots. Zero sales from engaged humans is a quality problem, not a filter problem. |
| **Clicks and EPC include scanners** | An affiliate's `clicks` / `affiliate_clicks` far above its `sessions` (e.g. 2,106 clicks vs 343 sessions) | Link scanners and crawlers never load the page, so they're outside `sessions`, but they count as clicks and deflate EPC. Compare affiliates on revenue per **session**, and state it ("$1.64 EPC, ~$10 per real session") |
| **Real buyers flagged `is_hosting`** | `ef sessions show` on buyer sessions shows `hosting: YES` (seen on a Google Ads Mac buyer and an iPhone Safari buyer: likely Private Relay / VPN). Call-center agents ordering from office/VPN IPs look the same, so check the affiliate before calling a hosting buyer a web visitor | Sessions metrics exclude hosting, so real visitors can drop out of the denominator. Treat CR as approximate; never label hosting traffic "bots" on that flag alone |
| **Page views not firing** | CR above ~15% on a cold-traffic funnel, or >100%; upsell pages with far more sales than sessions (3 sessions → 14 sales) | Trace buyer sessions (§5): `buy-link` event but no `page-view` = tracking gap. Until fixed, sessions-based CR and step tables are unusable for that funnel |
| **Post-checkout sessions undercount** | Low upsell-page sessions after a front end | Never call it a routing leak from sessions — confirm with orders (§4) |
| **Dashboard hover card "Visitors / Conv."** | Visitors ≫ `ef stats` sessions | Older backends counted click sessions incl. crawlers. Quote `ef stats` sessions/CR |
| **`ef stats by <field> --page <id>`** | Two different pages return identical rows | The grouped endpoint ignores `page_id` on some backends; `ef stats --page` (summary) does respect it. Don't slice a page by affiliate this way |
| **`ef list pages` hides pages** | A funnel page id isn't listed | It lists editor pages by default; use `ef list pages --all` or `ef pages get <id>` |
| **Draft pages serving** | Page `status: draft` yet has sessions and orders | Report as-is; don't assume draft = not live |
| **Sales ≠ main + upsell** | Totals don't add | The rest is bumps (e.g. shipping insurance `shi`) — not upsells |
| **Affiliate labels that aren't affiliates** | A big "Media Buys" (or similar) row whose `affiliate_clicks` is 0 | Check the row `key` in `--json`: an empty key is traffic with **no affiliate**, whatever the label says. Name it "no affiliate" |
| **Unattributed row** | `(unlabeled)` funnel/affiliate with big revenue | Orders with no session (IPN, off-site checkout) — report as its own line |
| **Profit looks healthy** | COGS tiny vs revenue, fulfillment 0 | Costs not entered — profit is an upper bound; say so |
| **Timezone** | Day totals shift between runs | Always state range + tz |

---

## 2. Where is the money — funnels and affiliates

```bash
ef stats by funnel_id --metrics sessions,sales,main_sales,upsell_sales,revenue,conversion_rate,aov,refund_pct --range 30d
ef stats --funnel <id> --metrics sessions,sales,main_sales,upsell_sales,upsell_take_pct,main_revenue,upsell_revenue,aov,main_order_value,upsell_order_value,refund_pct,profit --range 30d
ef stats by aff_id --funnel <id> --range 30d --limit 50 \
   --metrics sessions,sales,main_sales,upsell_sales,revenue,aov,main_order_value,upsell_order_value,refund_pct
```

- **AOV split:** `main_order_value` + `upsell_order_value` = `aov`. Upsell
  order value is upsell revenue spread over buyers ("each buyer adds $X in
  upsells"), not an upsell's price. Quote the server's values; its divisor is
  not a whole order count, so don't recompute.
- **Estimated profit per affiliate:**
  `ef stats by aff_id --metrics revenue,refund_total,commissions_paid,total_merchant_commission,taxes,net_revenue,cogs,total_fulfillment_cost,profit,profit_pct`.
  It reconciles as revenue − refunds − commissions − merchant commission −
  taxes = net_revenue; − cogs − fulfillment = profit. `commissions_paid_pct`
  can read 0 per row — use the dollar column. `ad_spend` $0 usually means not
  connected, not free traffic.
- Affiliate table: rank by revenue *and* by refunds; flag sessions-with-no-sales
  sources (§1) and sources whose refund rate is a multiple of the brand's.
- The same page in two funnels with very different CR is a **traffic**
  difference, not a page difference.

---

## 2b. Optimize per affiliate — their traffic, their buyers

One funnel serves very different audiences. An email list of pre-sold
buyers, a cold mobile VSL audience and a list that clicks but never buys can all land on the same
page, and a funnel-wide average fits none of them. For every affiliate that
matters (by revenue, or by sessions with no sales), build a profile and give
**affiliate-specific** recommendations.

**Profile per affiliate** (scope any stats command with `--aff <id>`; the id is
the row `key` in `ef stats by aff_id --json`):

```bash
A=<affId>; F=<funnelId>
ef stats --aff $A --funnel $F --range 30d \
  --metrics sessions,sales,conversion_rate,aov,main_order_value,upsell_order_value,refund_pct,profit,profit_pct
ef stats by device      --aff $A --funnel $F --range 30d --metrics sessions,sales,conversion_rate,engagement_rate,average_session_duration,aov
ef stats by page        --aff $A --funnel $F --range 30d --metrics sessions,sales,conversion_rate,average_session_duration
ef stats by country     --aff $A --funnel $F --range 30d --metrics sessions,sales,conversion_rate
ef stats by hour_of_day --aff $A --funnel $F --range 30d --metrics sessions,sales
ef orders buyers --funnel $F --aff $A --range 30d   # package mix + what their buyers took after (§4)
```

(If `ef orders` isn't available in the installed CLI, filter the §4 order
rows on `aff_id` instead.)

Read the profile as behaviour:

| Signal | Suggests |
|---|---|
| Seconds-long sessions, high CR (10%+), low AOV, a sale/discount landing page | **Pre-sold / email / list traffic.** They decided before arriving. |
| Minutes-long sessions on a VSL/TSL, mostly mobile, low CR (2–5%), high AOV | **Cold traffic persuaded on the page.** The page does the selling. |
| Package mix skewed to the biggest bundle | Committed buyers: "more of the same" upsells work. |
| Package mix skewed to 1–2 units | Triers: smaller, cheaper top-ups, or a different product. |
| Refund rate a multiple of the brand's | Over-promise in the affiliate's pre-sell, or incentivised traffic. Look at their angle before scaling. |
| Sessions that never load the page, stale UAs, `mail.google.com` / proxy referrers | Link scanners / bots (§1). Already outside sessions. Don't count them as lost visitors. |
| Hundreds of **human-looking** sessions (engaged, current UAs) with ~0 sales | **Affiliate-quality / offer-fit**, not bots. Don't filter them out of reporting. Try a landing that fits their audience, or renegotiate/stop. |
| Upsell take far below other affiliates on the same funnel | Their buyers may not reach, or not fit, the upsells. Check with orders and traces. |

**Turn the profile into affiliate-specific changes**, each tied to a number
from the profile:

- **Front end:** send the affiliate's traffic to the page that fits it.
  Pre-sold traffic goes straight to an order/packages page. Cold mobile
  traffic goes to a VSL tuned for mobile (load speed, above-the-fold order
  button, shorter intro).
- **Offer and price anchor:** a discounted front end needs price-matched
  upsells. Big-bundle buyers keep a same-product upsell. Triers get a smaller
  top-up.
- **Upsell path:** whether to lead with more of the same product or a
  different one, based on *this affiliate's* per-buyer takes, not the
  funnel's.
- **Checkout / merchant:** set per affiliate if their audience needs it (e.g.
  country, payment method), through a `set_merchant` / `set_checkout_page`
  node.
- **Economics:** profit per affiliate after commissions, merchant fees,
  refunds and costs (§2). A high-revenue, high-refund affiliate can be worth
  less than a small clean one. Recommend scaling or renegotiating on that
  basis.

**How to implement per affiliate** (only when the user asks; see the
`ef-page-events` skill):
- a page-event condition on `aff_id` that LOADs a different front end or
  upsell for that affiliate;
- or a dedicated funnel for a big affiliate, the way some brands run a
  funnel for a single partner.

Test changes as a split test scoped to that affiliate's traffic. Read the
result with `ef stats split` and never call it early. Record the hypothesis
per affiliate in `elasticfunnels/split-tests.md`.

**Report shape:** one short block per affiliate:
- who they are (traffic type, device, landing page);
- their numbers (sessions, CR, AOV main + upsell, refunds, estimated profit);
- what their buyers do (package mix, upsell takes);
- 1–3 changes for their traffic, ranked by money.

Keep the samples honest: most affiliates have a handful of buyers, so a
single sale moves their rates.

**Worked example** (one brand, 30 days). Two affiliates on the same product
need opposite funnels:

| | Affiliate A: internal email list | Affiliate B: cold mobile VSL traffic |
|---|---|---|
| Landing | discounted sale page, 6 units at ~$96 | VSL page (`/watch`) |
| Device / time on page | mobile, **~7 seconds** | 90% mobile, **~5 minutes** |
| Conversion | **15%** | **2.6%** |
| AOV | **$133** | **$259** main, and upsell value per buyer 50% above the brand |
| Package mix | almost all the discounted 6-pack | skewed to 6 bottles at full price |
| Upsell take | 0 of 17: never shown one, and the standard $234 upsell would cost 2.4× what they paid | 6-bottle buyers took "6 more at $174" at ~60% |
| Profit (est.) | n/a | $717 (20.7%), an upper bound since COGS was incomplete |
| **Changes for their traffic** | route them into upsells with a **price-matched** offer; keep the short order-page path | protect the $174 same-product upsell; tune the VSL for mobile; add a same-product downsell (none on that funnel) |

The funnel-wide averages hid both. A's 15% masked B's 2.6%, and B's upsell
success was invisible inside a 12–15% funnel take rate.

---

## 2c. Traffic source: Meta, Google, YouTube, TikTok, email…

An affiliate is a *who*; the traffic source is the *where*. The same
affiliate often buys on several platforms, and the same platform behaves
alike across affiliates. Profile both: **affiliate × source**.

```bash
ef stats by traffic_source --funnel <id> --range 30d \
  --metrics sessions,sales,conversion_rate,aov,main_order_value,upsell_order_value,refund_pct
ef stats by traffic_source --aff <affId> --range 30d --metrics sessions,sales,conversion_rate,aov
```

Backends with per-visit source classification return named sources (meta,
google_ads, phone, email, referral, affiliate-no-signal, direct…). Group by
`traffic_source_group` for the coarser channel, and filter with
`filter[traffic_source]`. If it returns "No data", or only AI crawler/assistant
groups, the backend doesn't classify sources yet (or the feature is off). Say so, and infer from what each visit carries:

- **UTMs:** `utm_source`/`utm_medium`. These are usually empty on affiliate
  traffic, so check coverage with `ef stats by utm_source` first.
- **Click IDs in the landing URL** (`ef sessions show <id> --full-urls`):
  - `fbclid` → Meta
  - `gclid` / `gbraid` / `wbraid` + `gad_source` / `gad_campaignid` → Google Ads
  - `ttclid` → TikTok
  - `msclkid` → Microsoft
  - `twclid` → X
  - `ScCid` → Snapchat
  - `epik` → Pinterest
  - `tblci` → Taboola
- **In-app browser user agents:**
  - `FBAN` / `FBAV` / `Instagram` → Meta
  - `musical_ly` / `TikTok` → TikTok
  - `GSA/` → Google app
- **Email:** `GoogleImageProxy` / `YahooMailProxy` fetches, mail-client user
  agents.
- **Affiliate sub-ids:** a gclid forwarded in `subid2` is Google Ads (common
  with affiliates bidding on search). An unfilled `{gclid}` macro means the
  affiliate *intended* Google Ads.

What real data showed (one brand, 30 days, all buyers classified):
- **Meta mostly arrives without `fbclid`.** One affiliate's Meta buyers
  (179 of 191) came through the FB/IG in-app browser with no click ID and no
  referrer. The in-app user agent is the main Meta signal.
- **The session's visit record has a referrer** (`ef sessions show`), even
  when click-row referrer fields are empty. It reveals affiliate presell and
  bridge pages (review blogs, `*.web.app`) and **brand-lookalike domains**
  (misspellings, `-usa.shop`, `-original.*`). Flag lookalikes as a
  compliance question for the user.
- **Phone / call-center orders** (e.g. an affiliate that is a call center) have no
  web session. They're a source of their own, not "direct".
- In-app-browser traffic is where page-view tracking is most likely to break.
  Cross-check a Meta-heavy affiliate's CR against the tracking-gap trap (§1).

Sampling buyers per affiliate (`ef orders list --aff <id>` →
`ef sessions show`) is one API call per session and rate-limited. Infer the
mix from a sample, and label it as a sample.

Read source behaviour the way §2b reads affiliates:
- Meta and TikTok in-app traffic is mobile, impulse-driven, and often skips
  long VSLs.
- Google search visitors arrive with intent: shorter paths, higher CR.
- YouTube viewers have usually already watched a video ad.
- Email visitors are pre-sold: seconds on page, high CR, discount-sensitive.

Recommend changes per source (front end, page length, mobile speed, offer and
price anchor), and per affiliate × source when one affiliate runs several
platforms.

---

## 3. Read the funnel graph correctly

```bash
ef funnels list                 # id ↔ code
ef funnels pull <code>          # → elasticfunnels/funnels/<code>.flow.json
ef funnels product-flow <id>    # compiled buy links per page (JSON, no --json flag)
jq -r '.drawflow[].data[] | [.id, .data.type, ((.data.value // .data.page // "")|tostring|.[0:60]),
  ([.outputs|to_entries[]? | "\(.key)->\([.value.connections[]?.node]|join(","))"]|join(" "))] | @tsv' \
  elasticfunnels/funnels/<code>.flow.json | column -t -s $'\t'
```

The model:

- `entry` → `page_group` (the **front-end sales pages**) → `purchase` /
  `decline` → next `page` (upsell/downsell) → … → `url_redirect` (members
  area). `router` + `product_check` → `product_check_product [codes]` /
  `product_check_all` branch on what was bought; `split_test` →
  `split_test_weight` splits traffic.
- **Checkout pages are NOT graph steps.** The checkout is chosen when the buy
  link is clicked, from the **active merchant** — set per active domain, and
  overridable (`set_merchant` / `set_checkout_page` page-event nodes, a
  funnel-level checkout page). A checkout page missing from the graph is
  normal; never report it as unwired.
- **Product checks match exact product codes.** A front end selling codes the
  checks don't list (e.g. `PRODUCT_MAIN_3B_X1` when the checks name
  `product_3`) falls through to `product_check_all` — its buyers silently
  get the generic upsell instead of the one built for their package. Compare
  the codes in `product-flow` for each front-end page against every
  `product_check_product` list.
- **A page in two page groups** makes the compiled `product-flow` show a path
  the runtime may not take. Trust orders and session traces over the
  compiled flow.
- Split-test variant pages (served at the same URL) often don't appear in
  `product-flow`; find them in `ef stats by page --funnel` and `ef stats splits`.

---

## 4. Per-buyer truth from orders

Sessions can't say who took an upsell; orders can:

```bash
ef orders buyers --funnel <id> --range 30d               # by front-end product code + price
ef orders buyers --funnel <id> --range 30d --by page     # by the page the package was bought on
ef orders buyers --funnel <id> --aff <affId> --range 30d # one affiliate's buyers (§2b)
```

Per buyer: the first non-bump purchase is the package; later non-bump
purchases within `--window` (default 24h) are takes, with the page each was
bought on. Bumps/bonuses come from the product records (`classification`),
plus any `--bump` codes. It shows list price vs **median paid** — a
discounted front end (6 bottles listed $594, paid ~$100) behaves nothing like
the same bottle count at full price. Give n beside every rate.

What this settles that nothing else does: which packages take "more of the
same" (commonly the biggest package at full price takes it best — don't
assume otherwise), whether a front end's buyers reach upsells at all, and
which offer each buyer actually saw ("bought on").

## 5. Confirm with session traces

Before reporting a routing or tracking problem, trace 2–3 real sessions:

```bash
ef orders list --funnel <id> --range 30d --json | jq -r '.orders[] | [.session_id, .code, .purchased_at] | @tsv' | head
ef sessions show <session_id>
```

`ef sessions show` prints the landing, affiliate, device, flags, the page path
(`/packages → checkout → /upsell-1 → /last-chance`) and marks a `buy-link`
with no earlier `page-view` as a **TRACKING GAP**. Compare against a buyer on
a healthy path. URL flags like `fallbacku=true` appear on normal paths too —
read the page sequence, not query flags.

## 6. Deliverables

- **Answer first**, then evidence: the one number or change that matters, the
  table behind it (range, tz, n), then consequences in money.
- **Rank recommendations by money at stake**, each tied to a number. Say what
  is measured vs inferred; small samples are signals, not verdicts.
- **Developer brief** (when asked "write this up for a dev"): a `.md` in the
  project (e.g. `research/<funnel>-dev-brief.md`) with a TL;DR issue table
  (severity, status), links, the graph as wired, then per issue: what we
  see, evidence tables, **sample session + order ids linked to the session
  view**, what to investigate, and "done when". Include a Reproduce section
  with the exact commands. No customer PII.
- **Retract loudly.** If orders or traces contradict an earlier claim, say so
  and correct the brief/skill — a wrong routing-leak or "change the upsell"
  call costs real money.

Hand-offs: step table and routing check → `ef-funnel-analysis`; upsell
pricing/offer fixes and split-test calls → `ef-upsell-diagnosis`; graph edits
→ `ef-page-events`; split-test readings → `ef-stats`.
