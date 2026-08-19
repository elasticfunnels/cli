---
name: ef-page-events
description: >-
  Author and edit ElasticFunnels page-event and funnel-builder graphs with the
  `ef` CLI. Use when a task means creating or changing page behaviour that is
  driven by the Drawflow graph rather than the page markup: split tests / A-B
  tests, "load" or "serve" a different page (white/safe pages, cloaking),
  redirects, conditions on query parameters, affiliate / country / VPN / tag
  routing, exit popups, dynamic content containers, tagging, set-merchant, and
  funnel builder flows. Triggers include "create a page event", "load the white
  page when …", "redirect if …", "split test", "A/B test", "show a popup on exit",
  edits to `pages/<slug>.events.json` or `funnels/<code>.flow.json`, and any
  mention of drawflow / node graph / page-event nodes for ElasticFunnels.
---

# ElasticFunnels page events & funnel graphs (CLI)

Page events and funnel flows are **Drawflow JSON graphs** that run on every page
view — split tests, redirects, "load another page", tags, popups, dynamic
content. You edit them as files with the `ef` CLI:

- Page events → `pages/<slug>.events.json` (one per page; nested slugs keep their `/`).
- Funnel builder → `funnels/<code>.flow.json` (the funnel's editable `config`).

They are **structured JSON, so there is no auto-merge**. Getting the workflow and
a few load-bearing rules right is what separates a graph that works from one that
silently does nothing.

---

## The one workflow — always pull first

Run these in order, every time. Skipping the pull is the most common way to
destroy someone else's edits.

```
# 1. PULL FIRST — establishes the baseline the safety check compares against.
ef pages events pull <slug>            # → pages/<slug>.events.json

# 2. Learn the node vocabulary from the SERVER (source of truth; see below).
ef pages events vocabulary <slug>

# 3. Edit pages/<slug>.events.json (keep every node you aren't changing, same ids).

# 4. VALIDATE against the server before saving — cheaper than a rejected push.
ef pages events validate <slug>        # add --strict to treat warnings as errors

# 5. PUSH.
ef pages events push <slug>
```

Funnels are identical with `ef funnels pull|push|diff|validate <code>` (same
deep validator as page events — see the funnels section).

### The safety guarantees (do not fight them)

Both page events and funnels enforce the **same** lost-update protection:

- **Push refuses (exit 4) if the server changed since you pulled.** You get
  `Changes rejected: … changed on the server since you pulled.` Nothing uploads.
- **Push refuses (exit 4) if you never pulled but the server already has a
  graph** — `… already has events on the server, but you never pulled them.`
  This is the always-pull-first guard: it stops a hand-authored or copied file
  from clobbering server state you've never seen.
- **A brand-new graph is allowed without a pull only when the server has none**
  (genuine fresh-create).

When a push is refused:

```
ef pages events diff <slug>            # or: ef diff pages/<slug>.events.json
```

shows the local-vs-server difference. Then **pick a side** — there is no merge
for JSON:

- keep yours → `ef pages events push <slug> --force`
- take the server's → `ef pages events pull <slug> --force`

Detect the refusal in automation by exit code `4` and the literal
`Changes rejected` in the message.

---

## The node vocabulary is the server's, not yours

**Never hand-invent node types.** `ef pages events vocabulary <slug>` returns the
authoritative list — every `type`, its input/output count, and its connection
rules (`only_on`, `max_per_output`, `one_of_type`, `executing_on`). It is always
current as new node types ship. The reference below covers the common ones and
the fields the vocabulary endpoint does **not** carry; consult the endpoint for
the full set and the exact rules.

`ef lint pages/<slug>.events.json` checks the file **structurally** offline
(valid JSON, drawflow shape). Deep node-rule checking is `ef … validate` only.

---

## Graph model — the shape every node follows

```jsonc
{
  "drawflow": {
    "Home": {
      "data": {
        "1": {
          "id": 1,
          "name": "entry",
          "data": { "type": "entry" },          // ← the node's real payload
          "inputs": {},
          "outputs": {
            "output_1": { "connections": [ { "node": "2", "output": "input_1" } ] }
          },
          "pos_x": 250, "pos_y": 250
        },
        "2": {
          "id": 2,
          "data": { "type": "page_variant", "value": "918" },
          "inputs": {
            "input_1": { "connections": [ { "node": "1", "input": "output_1" } ] }
          },
          "outputs": {}
        }
      }
    }
  }
}
```

Rules that the runtime actually depends on:

1. **`data.type` is the node.** The UI label is cosmetic; `type` is what runs.
2. **Every graph needs exactly one `entry` node** (`{"data":{"type":"entry"}}`,
   no inputs). Nothing runs without it. Its children are what execute.
3. **Connections are stored on BOTH ends.** The parent lists the child under
   `outputs.output_N.connections`; the child mirrors it under
   `inputs.input_1.connections`. An edge written on one side only never runs.
4. **On a 2-output condition, `output_1` = TRUE (yes) and `output_2` = FALSE (no).**
5. **Position is execution order.** Siblings run in `pos_y` then `pos_x` order;
   under a branching node the output index decides. Don't reposition existing
   nodes. New nodes: give increasing `pos_x`/`pos_y` (e.g. +250) so order is stable.
6. **One connection per output pin** (`max_per_output`). To run several actions
   off one branch, chain them, or use a `sequence` node (its extra outputs allow
   fan-out).
7. **Server node → browser node is fine; browser → server is not.** Once a path
   reaches the browser (`executing_on: frontend`) it stays there.

---

## Two rules that cause silent no-ops — read before writing a condition

### 1. LOAD ≠ REDIRECT — default to `page_variant`

**Serving another page is `page_variant` (Load Another Page) by DEFAULT.** It
renders that page's content at the URL the visitor already asked for — no
redirect, no URL change — and keeps an output so the graph can carry on. Reach
for a redirect node **only when the request explicitly says "redirect"** (or
plainly means: change the address bar / send them to an external site).

| Request says… | Node | Address bar |
|---|---|---|
| "**load** / **show** / **serve** / **display**" a page — *default* | `page_variant` | unchanged |
| "**redirect** to" a page in this brand | `page` (terminal) | changes |
| "**redirect** to" an external URL | `url_redirect` (terminal) | changes |

"white page" (also "safe page", "money page", …) is **not** a special node or a
hard-coded target — it is just the name of the page you want to serve. Resolve it
to a real page id with `ef list pages --json` (match the slug/title):
`page_variant.data` = `{ "value": "<pageId>", "slug": "<slug>" }`.

For cloaking / white-page rules `page_variant` is not merely the default, it is
the correct node: a redirect would change the URL to the white page and give the
cloaking away — `page_variant` serves it in place. When the intent is ambiguous,
**load (`page_variant`), don't redirect.**

### 2. A typed condition needs its compiled `script_rule`, or it never fires

`query_param_condition`, `referred_by_affiliate`, `is_from_country`, and every
other "friendly" condition is really a **Script Rule** at runtime: the renderer
runs `data.script_rule`, not the friendly fields. The compile step lives in the
**builder UI** — **nothing on the server recompiles it.** So if you write the
graph through the CLI and set only `data.conditions` (or only `affiliate_ids`)
**without** `data.script_rule`, the node is inert: it has nothing to run and the
condition never passes. `validate` will not save you from this.

**The reliable pattern for CLI/AI authoring: use a plain `script_rule` node** —
single field, always executes:

```jsonc
{ "data": { "type": "script_rule", "script_rule": "return query.test == '1';" } }
```

If you prefer the typed node (nicer for a human editing later), you MUST set
**both** fields, kept in sync. Compile `conditions` yourself:

| operator | compiled comparison |
|---|---|
| `is` | `query.<param> == '<value>'` |
| `is_not` | `query.<param> != '<value>'` |
| `contains` | `query.<param>.includes('<value>')` |
| `starts_with` / `ends_with` | `query.<param>.startsWith('<value>')` / `.endsWith(...)` |
| `is_empty` | `!query.<param> \|\| query.<param> == ''` (present-or-not; ignores value) |

`logicalOperator` (`&&` / `||`) joins each condition to the next; the body is
`return <expr>;`.

> **"missing `test=1`" is not `is_empty`.** `is_empty` only asks whether the
> param is present, so `?test=2` counts as *not* empty. Say the condition
> **positively** — `is` / `test` / `1` — and hang the work off the branch you
> want: white page on **`output_2`** (the false branch). Don't invert the operator.

Script-rule condition inputs available: `query.<param>`, `session.aff_id`,
`is_customer`, `customer`, `ip_whois.country_code` / `.state` / `.is_eu` /
`.timezone.id` / `.security.*`, `tags`. Generated forms:
`referred_by_affiliate` → `return [<ids>].includes(session.aff_id);`,
`is_from_country` → `return [<codes>].includes(ip_whois.country_code);`.

---

## Worked examples

### "Load the white page on `report` if it's missing `?test=1`"

Pull `report`, then build: entry → condition(`test == 1`) → **false branch loads
the white page** (visitors *with* `test=1` fall through the true branch and see
`report` normally).

```jsonc
{ "drawflow": { "Home": { "data": {
  "1": { "id": 1, "name": "entry", "data": { "type": "entry" },
         "inputs": {}, "outputs": { "output_1": { "connections": [ { "node": "2", "output": "input_1" } ] } },
         "pos_x": 250, "pos_y": 250 },
  "2": { "id": 2, "data": { "type": "script_rule", "script_rule": "return query.test == '1';" },
         "inputs": { "input_1": { "connections": [ { "node": "1", "input": "output_1" } ] } },
         "outputs": {
           "output_1": { "connections": [] },                                   // test=1 → true → do nothing
           "output_2": { "connections": [ { "node": "3", "output": "input_1" } ] } // missing/other → load white
         },
         "pos_x": 500, "pos_y": 250 },
  "3": { "id": 3, "data": { "type": "page_variant", "value": "<whitePageId>", "slug": "white" },
         "inputs": { "input_1": { "connections": [ { "node": "2", "input": "output_2" } ] } },
         "outputs": {}, "pos_x": 750, "pos_y": 250 }
} } } }
```

Then `ef pages events validate report` → `ef pages events push report`.

### "For affiliate <id>, load the white page"

entry → condition(referred by affiliate) → **true branch loads the white page**.

```jsonc
"2": { "id": 2, "data": { "type": "script_rule", "script_rule": "return [<affId>].includes(session.aff_id);" },
       "inputs": { "input_1": { "connections": [ { "node": "1", "input": "output_1" } ] } },
       "outputs": {
         "output_1": { "connections": [ { "node": "3", "output": "input_1" } ] },  // is that affiliate → load white
         "output_2": { "connections": [] }
       }, "pos_x": 500, "pos_y": 250 }
```

(Equivalent typed node: `{"type":"referred_by_affiliate","affiliate_ids":[<affId>],"script_rule":"return [<affId>].includes(session.aff_id);"}` — remember **both** fields.)

---

## Common node reference

Fields below are the ones the vocabulary endpoint doesn't carry. Run
`ef pages events vocabulary <slug>` for the full list, output counts, and
`only_on` rules. Condition nodes are 1-in / 2-out (out1 = true, out2 = false).

**Flow / entry**
- `entry` — start; `{ "type": "entry" }` (server fills `value` = page id).
- `sequence` — fan-out; the one node with 2+ outputs, one action per branch.
- `stop_execution` — end the path and drop the browser event queue. Terminal.
- `router` — canvas junction, pass-through.

**Conditions (server)** — all also runnable as a plain `script_rule` (see rule 2)
- `script_rule` — `{ script_rule: "return <bool>;" }`. Most flexible.
- `query_param_condition` — `{ conditions: [{param,operator,value,logicalOperator}], script_rule }`.
- `referred_by_affiliate` — `{ affiliate_ids: [...], script_rule }`.
- `is_from_country` / `is_from_state` / `is_from_timezone` — `{ countries|states|timezones: [...], script_rule }`.
- `is_from_eu`, `is_using_vpn`, `is_customer`, `accepted_upsells`, `is_whitelisted` — no fields.
- `has_tag` — `{ value: "<tag>" }`. `cloaking_house` — `{ value, label }`.
- `product_check` (parent) → `product_check_product` `{ value: "<code>" }` / `product_check_all` (both `only_on: product_check`).

**Content & routing**
- `page_variant` (Load Another Page) — `{ value: "<pageId>", slug }`. Keeps an output.
- `page` (Redirect to Page, terminal) — `{ value: "<pageId>", slug, code }`.
- `url_redirect` (terminal) — `{ value: "<url>", keep_query_params }`; supports `{click_id}`, `{query.<param>}`.
- `dynamic_container` — `{ container: "<containerId>", component: "<componentCode>" }`.
- `exit_popup` (terminal) — `{ value: "<popupId>" }`.
- `show_element` / `hide_element` — `{ value: "<cssSelector>" }`. `client_script` — `{ client_script }` (call `ef.nextNode()` to continue).

**Session / commerce / security**
- `add_tag` — `{ value: "<tag>", expiration_minutes }`. `set_variable` — `{ variables: {…} }`.
- `set_merchant` — `{ value: "<merchantId>", … }`. `clear_merchant` — none.
- `set_checkout_page` — `{ value: "<pageId>", slug }`. `execute_automation` — `{ automation_id, delay }`.
- `mark_whitelisted` — `{ value: <minutes> }` (`0` = permanent). `block_request` — `{ value: "<message>" }`.

**Split testing** (fixed four-level shape — see below)
- `component_split_test` — `{ container: "<splitTestContainerId>", value: <2–5 variantCount>, name }`. Ends its branch.
- `split_test` — `{ value: <2–5>, name }`.
- `split_test_weight` (Traffic Distribution, `only_on: split_test/component_split_test`) — `{ value: <percent>, name }`. Weights sum to 100.
- `component_split_test_component` (`only_on: split_test_weight`, terminal) — `{ component: "<componentCode>", baseline }`.

**Component split test shape** (four levels, exact):
`entry → component_split_test {container, value:N} with output_1..output_N →`
one `split_test_weight {value:<percent>}` per output (summing to 100) →
exactly one `component_split_test_component {component:"<code>"}` under each
weight. The leaf type is `component_split_test_component` and the code goes in
`data.component`; there is no bare "component" node and the code never lives on
the weight. Split-test containers come from the `<split-test>` tags in the
page's `.ef` markup.

---

## Funnels (`funnels/<code>.flow.json`)

Same Drawflow model, same always-pull-first / refuse-on-drift safety, same
`ef diff funnels/<code>.flow.json` to inspect a refusal. Differences:

- Edit **only** `funnels/<code>.flow.json` (the builder `config`). The funnel's
  `flow`, `product_flow`, and `variant_seeds` are **read-only** — the server
  regenerates them on save. Inspect the compiled artifacts with
  `ef funnels debug-flow <code>` / `ef funnels product-flow <code>`; never edit them.
- **Validate with `ef funnels validate <code>`** — deep, server-side, the same
  engine as page events (node types, `only_on`/`max_per_output`/`one_of_type`,
  connection integrity, orphan/reachability). `ef lint funnels/<code>.flow.json`
  is the offline structural check. Also verify the compiled output with
  `ef funnels debug-flow`.
- Funnel node types are their own set (`module: funnels`) — get them from a
  pulled example plus `ef pages events vocabulary` (shared registry) rather than
  assuming they match page events.
- Create: `ef funnels create "<title>" --domain <id>` (a domain is required; the
  **server assigns the code**). Then pull it before editing.

---

## Record the test you just created

A split test's numbers live on the server; **why** you ran it does not. The
hypothesis, which variant is which, and what "winning" would mean exist only in
the conversation that created it — and they are exactly what the next person,
or the next session, needs in order to read the result.

So after creating or changing a split test, append an entry to
`elasticfunnels/split-tests.md` (create the file if it is not there):

```markdown
## #503 — Herpafend Prelander A/B (page: herpafend-pre, id 16109)
- Created 2026-08-19. Status: running.
- Variants: A "Self-assessment" 50% (original) · B "Listicle" 50% (herpafend-pre-v2, id 16110)
- Hypothesis: a self-assessment opener qualifies harder and lifts CVR downstream.
- Winning means: B beats A on `conversion_rate` at the server's own verdict.
- Check with: `ef stats split 503`
```

Rules that keep the file worth reading:

- **Append, never rewrite.** Old entries are the record of what was tried; a
  test that lost is as useful to the next person as one that won.
- **Always include the split test id** — it is the join key to
  `ef stats split <id>`, and the only stable handle. Page slugs get renamed.
- **Name every variant and its weight**, including the implicit one. A weight
  node with no `page_variant` child is the *original* page; say so, or nobody
  can tell later which arm was the control.
- **Update the entry when you declare a winner**, with the date and the number
  that decided it.
- It lives in `elasticfunnels/` so it is committed with the project and a
  teammate gets it too. It never syncs to the server — the CLI knows to leave
  it alone.

Read this file before answering "how is the test doing" — it is what turns a
variant label into a decision.
