# `ef` — ElasticFunnels CLI

A folder-scoped command-line tool for ElasticFunnels. Built for Claude Code,
Codex, scripts, CI pipelines, and humans.

```bash
$ ef init                    # bind this folder to a brand (browser sign-in)
$ ef pull                    # full sync (pages, components, scripts, assets, variables)
$ ef push pages/about-us.ef  # push one page (uses optimistic concurrency)
$ ef list pages --json       # machine-readable list of pages
$ ef pages list              # same table as `ef list pages`
$ ef preview about-us        # preview URL (top-level; same API as the VS Code extension)
$ ef pages preview about-us  # same preview + live URLs under the `pages` group
```

## Install

```bash
npm i -g @elasticfunnels/cli
```

Then run `ef --help`. Requires Node.js ≥ 18.

**Staying current:** `ef` checks npm about once a day (in the background, never
blocking a command) and prints a one-line `▲ Update available X → Y` nudge to
stderr on interactive runs when a newer version is out. Act on it with:

```bash
ef update            # upgrade in place
ef update --check    # just report; change nothing
```

`ef update` works out which package manager installed the copy you are running
— npm, pnpm, yarn or bun — and runs that one, into the same prefix, so you never
end up with a second copy while the old one stays on your PATH. It only touches
a **global** install: a project-local copy or a source checkout is reported with
the command that is right for it, and nothing is run.

The nudge itself stays silent in scripts, pipes, CI, and with `--json`. Disable
it entirely with `NO_UPDATE_NOTIFIER=1` (or `EF_NO_UPDATE_NOTIFIER=1`).

### From source

```bash
git clone https://github.com/elasticfunnels/cli.git
cd cli
npm install
npm run build
npm link            # adds `ef` to your PATH
```

To work on the CLI itself:

```bash
npm run watch       # incremental tsc
node bin/ef.js ...  # run from source without npm link
npm test            # run the test suite (zero deps, uses node --test)
npm run lint        # eslint over src/
```

Contributors: see [CONTRIBUTING.md](./CONTRIBUTING.md) for the release flow.

## Source layout

The CLI mirrors the top-level folders of the ElasticFunnels VS Code extension
so API and sync logic stay easy to compare side by side:

| Extension | CLI |
| --- | --- |
| `extension.ts` | `extension.ts` (entry + Commander wiring) |
| `api/client.ts` | `api/client.ts`, `api/types.ts` (re-exports `models/*`) |
| `commands/pageCommands.ts`, `componentCommands.ts` | `commands/pageCommands.ts`, `componentCommands.ts`, plus other `commands/*.ts` for auth/sync |
| `models/*` | `models/*` |
| `providers/*` (tree, hover, …) | `providers/index.ts` (no-op — CLI has no GUI) |
| `sync/*` | `sync/*` (`efMeta.ts`, `stateFile.ts`, `paths.ts`, `sync.ts`, …) |
| `utils/*` | `utils/*` (logging, config store in `utils/store.ts`, fs helpers, …) |

GUI-only extension files are not duplicated in the CLI.

## Tests

The CLI ships with a suite of fast unit tests under `test/` that use
[`node --test`](https://nodejs.org/api/test.html) — no test framework, no
deps. The suite covers:

- `sync/efMeta` parse/serialize round-trip (template + legacy + BOM + CRLF)
- `safeJoinBrandRoot` path-traversal defense
- `relPathFor*` slug → on-disk path conventions
- Asset path normalization
- `Config` store: write → read → wipe round-trip, file permissions
- Format helpers: bytes, relative time, table alignment
- Binary-asset placeholder detection
- **Secrets regression**: spawns the real `bin/ef.js` against a fake brand and
  asserts the API key never appears in stdout/stderr from `whoami` or
  `whoami --json`.
- Login resilience: `--non-interactive` and non-TTY stdin fail fast with a
  clear validation error instead of hanging.

Run `npm test`. The runner compiles main `out/` plus a separate `out-test/`
tree, then executes every `*.test.js` under it.

## Why folder-scoped?

The VS Code extension stores brand and key in `.vscode/settings.json`. The CLI
mirrors that idea: each project directory has its own `.ef/` folder containing
config and an API key. Switching projects switches the brand automatically —
no global state, no profile flag, no risk of pushing to the wrong brand from
a forgotten shell session.

```
your-project/
├── .ef/
│   ├── config.json   # api url, brand id, sync root, save mode
│   └── auth          # API key (chmod 600)
├── elasticfunnels/   # default sync root (brand id lives in config, not the path)
│   ├── pages/
│   │   ├── home.ef
│   │   └── pricing.ef
│   ├── components/
│   │   └── header.ef
│   ├── scripts/
│   │   └── welcome-email.js
│   ├── assets/
│   │   └── images/logo.png
│   ├── variables.json
│   └── .ef-state.json   # baselines (content hashes, revisions)
└── .gitignore        # `.ef` added automatically by `ef init`
```

This is the default **flat** layout — identical to the VS Code extension, so
the same folder is interchangeable between the two tools. If you'd rather keep
several brands side by side under one sync root, pass `--sync-layout nested`
and each brand's files land under `elasticfunnels/<brandId>/…` instead.

## Auth model

**`ef init` signs you in through the browser.** Nothing secret is typed, pasted
or left in your shell history:

```
$ ef init

  Your code:  WDJB-MJHT
  Open:       https://app.elasticfunnels.io/cli-auth?code=WDJB-MJHT

  Approve it in your browser and this will continue on its own.
```

The CLI holds a secret `device_code`; the short code above is the only thing
displayed, and on its own it cannot collect anything. You approve in a browser
session that is already signed in and pick which brand to grant — so `--brand-id`
is unnecessary. This is the RFC 8628 device-authorization flow.

What you get back is a **per-device token** (`efc_…`): stored server-side as a
sha256 hash, scoped to one (user, brand) pair, and revocable on its own from
**Settings → account menu → Connected devices**. Revoking one machine leaves
every other integration working.

Other ways in, when the browser flow doesn't fit:

| Situation | Command |
| --- | --- |
| Machine with no browser (a remote server) | `ef init --code <pairing-code>` — mint it in **Settings → AI tools → advanced**. Works once, expires in 10 minutes. |
| CI / scripted, unattended | `ef init --api-key <key> --brand-id <id>`, or `$EF_API_KEY`. A non-interactive run refuses the browser flow rather than hanging on it. |
| Force browser sign-in anyway | `ef init --auth` |

### When a credential stops working

Disconnect a device (or regenerate a brand key) and the next command fails with
exit 3. **Run `ef login`** — it replaces `.ef/auth` and nothing else, so the
brand binding, your settings and every synced file survive:

```bash
ef login                    # browser sign-in
ef login --code ABCD-1234   # headless machine
ef login --api-key <key>    # unattended / CI
```

The new credential has to be for the brand the folder is already bound to;
approving a different one is refused rather than silently leaving a config and
a token that disagree. To actually switch brands, use `ef reset` then `ef init`.

On an interactive terminal `ef pull` offers this inline — it prints the failure,
asks *"Sign in again now?"*, and retries the pull with the new credential. In a
script, a pipe, CI, or under `--json` it never prompts (that would hang the
caller, including the `ef claude` SessionStart hook); it exits 3 with the fix in
the message.

- The legacy per-(user, brand) `EF-Access-Key` from the brand's **Settings → API**
  page still works everywhere. It is stored in plaintext, is account-wide for the
  brand, and can only be revoked by regenerating it — which breaks every other
  integration at once. Prefer the device flow.
- Either way the credential lands in `.ef/auth` (chmod 600) and the rest of the
  config in `.ef/config.json`. `.ef/` is added to `.gitignore` automatically when
  a Git repo is detected.
- `ef init` refuses to run if the current folder is **already bound** (`.ef/`
  exists) — run `ef reset` first to switch brands. If the folder isn't empty
  but is unbound, it warns and asks for confirmation (skip with `--force`, or
  bypass entirely in non-interactive/CI runs).
- `ef reset` deletes both files. Synced pages/components/assets on disk
  are left alone — `ef reset` only removes credentials.

## Commands

Run `ef --help` to see the full tree, and `ef <cmd> --help` for any subcommand.

| Command | What it does |
| --- | --- |
| `ef init` | Bind this folder to a brand. Browser sign-in by default; `--code` for a one-time pairing code, `--api-key`/`--brand-id` (or `$EF_API_KEY`) for unattended runs. Errors if already bound; warns + confirms if the folder isn't empty (`--force` to skip). |
| `ef login` (alias `ef auth`) | Sign in again for this folder, replacing only the stored credential. Use after disconnecting a device or regenerating a key. `--code` / `--api-key` for headless and CI. Keeps the brand binding and every synced file. |
| `ef collections` | The form stores behind lead-capture forms: `list`, `get <code>`, `fields`, `entries <code>`, `create <name> --field Email:email:required`. `create` prints the **code** a form's `action` must reference — the reliable way to wire a form on a page that contains `{{ }}` or `@if`, where server-side auto-wiring is skipped. |
| `ef reset` | Unbind this folder — remove `.ef/`. |
| `ef install-highlighter` | Install the `.ef` syntax-highlighting extension into your editor (Cursor / VS Code / VSCodium). `ef init` also maps `*.ef` → `handlebars` in `.vscode/settings.json` as a no-install fallback. |
| `ef update` | Update the CLI in place, using whichever package manager installed it (npm/pnpm/yarn/bun) and the same prefix. `--check` reports without installing; `--force` reinstalls the latest anyway. Global installs only — a project-local copy or source checkout is reported, not touched. |
| `ef claude` | Write ElasticFunnels guidance into `CLAUDE.md`, install the bundled skills (`ef-page-events`, `ef-stats`) into `.claude/skills/`, and add a **SessionStart hook** that runs `ef pull --if-stale 30` so a session never starts on stale pages. Idempotent; `--no-skills` / `--no-hook` to skip either, `--print` to preview. `ef init` runs this too. |
| `ef codex` (alias `ef agents`) | The same guidance, written to `AGENTS.md` — the file Codex and several editors read. Codex has no skills or hooks, so the pull-before-you-work rule lives in the text. |
| `ef cursor` | The same guidance again, as a Cursor project rule at `.cursor/rules/elasticfunnels.mdc` (YAML frontmatter + the managed block). The frontmatter is written **once**, on create — narrow the rule with `globs` or `alwaysApply: false` and your edit survives every later refresh. `ef init` writes all three files. |
| — | The managed block is **stamped with the CLI version** that wrote it, and **any** command re-stamps a block written by an older CLI. So after `ef update`, each project's guidance refreshes itself on next use instead of describing a tool that has moved on. Files without a managed block (e.g. `ef init --no-claude`) are never created or touched. |
| `ef mcp` | Serve this brand to a desktop AI app (Claude Desktop, ChatGPT Desktop) over **stdio MCP**. Credentials come from the project's `.ef/auth`, so the app's config file holds no secret. `--project <dir>` to point at a folder explicitly. |
| `ef whoami` | Print the active project root, brand, API URL, key prefix. |
| `ef status` | Connection check, last-pull timestamp, entity counts. |
| `ef list <kind>` | List pages \| components \| assets \| scripts \| folders \| templates. |
| `ef preview <slugOrId>` | Print editor preview URL (uses draft `revision_id` when present). `--live` for public site URL only. |
| `ef get <kind> <idOrSlug>` | Fetch one entity. Defaults to printing HTML body; `--json` for full payload. |
| `ef pull` | Full sync (pages + components + scripts + assets + variables). |
| `ef pull <target>` | Targeted pull, e.g. `ef pull pages` or `ef pull pages/about-us.ef`. |
| `ef pull --merge` | For locally-edited files, **3-way merge** the server version into yours (git-style `<<<<<<<`/`=======`/`>>>>>>>` conflict markers on overlap) instead of keeping local and warning. |
| `ef pull --events` | Also pull each page's events graph to `pages/<slug>.events.json` (funnel builder / split tests). Off by default. |
| `ef pull --since <iso>` | Incremental pull using the server's sync-delta endpoints (pages and assets only). |
| `ef pull --if-stale <min>` | Pull only if the last one was longer ago than `<min>`; otherwise exit immediately without touching the network. What the SessionStart hook runs. Only a **complete** sync counts — an interrupted or failed one doesn't suppress the retry. |
| `ef push <paths…>` | Push specific files. **Refuses (exit 4) if the entity changed on the server since you pulled** — "Changes rejected … `ef diff --server` / `ef pull --merge`" — preventing a lost update. Covers pages/components/scripts/assets. |
| `ef push <paths…> --force` | Overwrite the server even on drift (a copy of yours is kept; the pre-push safety check is skipped). |
| `ef push --all` | Push every file under the brand root. |
| `ef push <paths…> --draft` | Save as a draft instead of publishing (publishing is the default). |
| `ef push --dry-run` | Print what would be pushed without making any API calls or disk writes. |
| `ef watch` | Watch the brand root and auto-push files as you save them (`--draft`/`--direct`; Ctrl-C to stop). |
| `ef diff [paths…]` | Show local-vs-baseline drift across the brand root (or restricted to paths). |
| `ef diff --server [paths…]` | Fetch server content and show the **real** server-vs-local difference (unified diff + `both-changed` status). |
| `ef pages list` | List pages (alias `ef pages ls`; same output as `ef list pages`). |
| `ef pages create <slug>` | Create a new page. |
| `ef pages publish <slug>` | Publish the latest editor draft for a page. |
| `ef pages preview <slug>` | Print preview + live URLs (draft revision from editor when present). |
| `ef pages duplicate <slug>` | Duplicate a page. |
| `ef pages settings <slug>` | Update page settings (slug, domain, folder, status, SEO) — flags and/or `--file`. Separate from editor HTML. `--sitemap`/`--no-sitemap` lists the page in the brand's `sitemap.xml` + `llms.txt`. |
| `ef pages delete <slug>` | Delete a page. |
| `ef pages events pull [slug]` | Pull a page's events graph → `pages/<slug>.events.json` (nested slugs preserved). `--all` for every page that has events. Not pulled by `ef pull` unless `--events`. |
| `ef pages events push <slug>` | Push `pages/<slug>.events.json` (validates first; `--strict` blocks on errors). **Refuses (exit 4)** if the server changed since you pulled, or if you never pulled a page that already has events (always-pull-first); `--force` overwrites. No auto-merge (structured JSON). |
| `ef pages events validate <slug>` | Validate the events graph (local, or `--stored` for the server's). |
| `ef pages events vocabulary <slug>` | Print the valid event-node vocabulary (node types + connection rules). |
| `ef pages events diff <slug>` / `ef diff pages/<slug>.events.json` | Show the local-vs-server events graph diff (no merge — pick a side). |
| `ef funnels list` | List funnels. |
| `ef funnels pull [codeOrId]` | Pull a funnel's builder graph → `funnels/<code>.flow.json`. `--all` for every funnel. |
| `ef funnels push <codeOrId>` | Push the builder graph. **Refuses (exit 4)** if the server changed since you pulled, or if you never pulled a funnel that already has a graph (always-pull-first); `--force` overwrites. No auto-merge (structured JSON). |
| `ef funnels diff <codeOrId>` / `ef diff funnels/<code>.flow.json` | Show the local-vs-server funnel-graph diff. |
| `ef funnels validate <codeOrId>` | Deep-validate the builder graph server-side (same engine as page events: node types, `only_on`/`max_per_output`/`one_of_type`, connection integrity, reachability). `--stored` validates the server's copy; `--json` for the full report. |
| `ef funnels create <title> --domain <id>` | Create a funnel (server assigns the code; a domain is required) and write its empty graph. |
| `ef funnels debug-flow <codeOrId>` / `product-flow <codeOrId>` | Print the compiled read-only flow / product-flow. |
| `ef funnels delete <codeOrId>` | Delete a funnel (and its local file). |
| `ef components create <code>` | Create a new component. |
| `ef components preview <codeOrName>` | Print the component preview URL (draft revision when present; `--published` for the live version). |
| `ef components delete <codeOrName>` | Delete a component. |
| `ef products list` | List products (alias `ef products ls`; `--classification` to filter). |
| `ef products get <id>` | Print one product as JSON. |
| `ef products create` | Create a product (`--title` + `--code` required; flags and/or `--file`). |
| `ef products update <id>` | Update a product — only the fields you pass (flags and/or `--file`). |
| `ef products clone <id>` | Clone a product. |
| `ef products delete <id>` | Delete a product. |
| `ef scripts create <code>` | Create a new backend script. |
| `ef scripts pull <codeOrId>` | Pull one backend script. |
| `ef scripts push <pathOrCode>` | Push one backend script. |
| `ef scripts get <codeOrId>` | Print script body or `--json` payload. |
| `ef scripts delete <codeOrId>` | Delete a script (and its local file). |
| `ef assets upload <localPath>` | Upload a local file. `--as <remotePath>` to override. |
| `ef assets bulk-upload <paths…>` | Upload many files/dirs at once (batched ≤20/request). `--to`, `--flat`, `--concurrency`. |
| `ef assets pull <remotePath>` | Pull one asset. |
| `ef assets delete <remotePath>` | Delete an asset. |
| `ef variables get` | Print brand variables JSON. |
| `ef variables set <key> <value>` | Set one variable, then push. Dotted keys nest (`brand.name`); values are JSON-typed (`180`, `true`, `{…}`) or a string; `@file` reads from a file; `--string` forces a literal. |
| `ef variables pull` | Write `<brandRoot>/variables.json`. |
| `ef variables push [--file]` | Push the variables JSON to the server. |
| `ef domains list` | List the brand's domains (alias `ef domains ls`) with status + SSL. |
| `ef domains add <domain>` | Add a dedicated (customer-owned) domain — kicks off Cloudflare hostname creation. `--subdomain <label>` (+ `--root`) adds a platform subdomain instead. `--records` waits for and prints the DNS records. |
| `ef domains records <domain>` | Print the DNS records to add: a TXT ownership record + a CNAME to the platform domain. `--wait` polls until the TXT record is ready. |
| `ef domains validate <domain>` | Queue validation for a dedicated domain (checks DNS + issues SSL). |
| `ef domains remove <domain>` | Delete a domain from the brand (alias `ef domains rm`). |
| `ef seo status` | Which discovery files (`sitemap.xml`, `llms.txt`, `robots.txt`) this brand serves, and how many pages they list. |
| `ef seo set <key> <value>` | Turn a file on/off or set its content. Keys: `sitemap`, `llms`, `robots` (booleans), `site-name`, `site-summary`, `llms-notes`, `robots-extra` (text). |
| `ef seo get [key]` | Print the SEO settings, or one key (pipeable on stdout). |
| `ef seo pages` | List the pages that appear in the discovery files, with the exact URL each one publishes. |
| `ef stats` | Headline metrics for a date range: `--metrics revenue,sessions,cpc`, `--range today\|yesterday\|7d\|30d\|mtd\|qtd\|ytd\|<n>d`, or explicit `--from`/`--to`. Scope with `--page`/`--funnel`/`--split-test`/`--aff`. `--raw` prints the server payload unreduced. |
| `ef stats metrics` | The metric keys **this brand** exposes, grouped. Discovered per request, not hardcoded — the registry is assembled server-side from the brand's plan modules and your role permissions, so it differs between brands on the same release. `--split-tests` for the split-test-valid subset. |
| `ef stats by <field>` | The same metrics broken down by one dimension — `page`, `product`, `country`, `utm_source`, `day`, `device`, … `--limit`, `--sort <metric>`. Time dimensions come back in time order; everything else biggest-first. |
| `ef stats fields` | Every dimension `ef stats by` can group on, by category. |
| `ef stats cards` | The dashboard cards this brand has, and the report scopes each one can **resolve** in. `--scope page\|funnel\|split_test\|component_split_test` narrows to the cards that can answer for that scope; `--category <key>` to one family. A card missing a scope is one whose data source ignores that filter — it would answer with the brand's figure under a narrower heading. |
| `ef stats splits` | List the brand's split tests. |
| `ef stats split <id>` | One test's per-variant metrics plus the **server's** significance verdict (p-value, power, sample floor, winner). Read rather than recomputed, so it can't disagree with the dashboard about who won. |
| `ef stats dashboards` | Saved dashboards and the available presets. |
| `ef lint [paths…]` | Statically validate `.ef` pages/components/scripts (template + script syntax). Exits non-zero on errors; `--strict` fails on warnings, `--json` for machine output. |
| `ef crm entities` / `pipelines <entity>` / `stages <pipeline>` / `fields <entity>` / `entries <entity>` | List CRM objects. `entities`/`pipelines`/`fields`/`entries` accept an entity **id or slug**. |
| `ef crm entities create` · `pipelines create <entity>` · `stages create <pipeline>` · `fields create <entity>` · `entries create <entity>` | Create CRM objects. Common fields via flags, or the whole payload via `--input-json`/`--input-file` (flags override). `--generate-skeleton` prints an example payload. |
| `ef crm entries update <entry>` / `move <entry> --stage <id>` / `delete <entry>` | Update an entry (`values` merge), move it to a stage, or delete it. Entries are Elasticsearch docs (string ids). |

### JSON input for complex commands

Commands with rich payloads (currently `ef crm …`) accept an AWS-style JSON input in addition to flags:

```bash
ef crm entries create leads --generate-skeleton              # print an example payload
ef crm entries create leads --input-file entry.json          # send a payload file ("-" = stdin)
ef crm entries create leads --input-json '{"title":"Jane","pipeline_id":1,"stage_id":2,"values":{"budget":5000}}'
ef crm entries create leads --input-file entry.json --title "Override"   # flags win over JSON fields
```

`--input-json` and `--input-file` are mutually exclusive; any flags you also pass override the matching JSON fields.

## Exit codes

Stable so scripts can branch on them.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic / unknown error |
| `2` | Bad usage: missing argument, validation failure |
| `3` | Auth: not logged in, key rejected |
| `4` | Conflict: HTTP 409 / file changed online while you had it |
| `5` | Network: DNS, timeout, connection refused |
| `6` | Server: backend 5xx or unexpected response |
| `7` | Not found: the file or entity you asked for doesn't exist |
| `130` | Interrupted (Ctrl-C). Whatever had downloaded is saved and recorded — re-run to finish. |

## Guidance for AI tools

`ef init` (and `ef claude` / `ef codex` / `ef cursor` on their own) writes the
same ElasticFunnels guidance into every place an AI tool looks for it:

| File | Read by |
| --- | --- |
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Codex, and several editors |
| `.cursor/rules/elasticfunnels.mdc` | Cursor |

All three carry one **managed block** between `<!-- ef:begin -->` markers,
stamped with the CLI version that wrote it. Everything outside the markers is
yours and is never touched — including a Cursor rule's frontmatter.

**They keep themselves current.** Any command that finds a project re-stamps a
block written by an older CLI, so after `ef update` the guidance refreshes on
next use instead of quietly describing a tool that has moved on. This can't
happen during `ef update` itself — that process *is* the old binary, so
stamping there would mark the old guidance as current and suppress the real
refresh. It writes nothing when the block is already current, and never creates
a file that wasn't there, so `ef init --no-claude` stays opted out.

You do **not** need to run `ef claude` / `ef codex` / `ef cursor` after an
install or an update — `ef init` writes all three, whichever tool you use, and
they refresh themselves after that. Those commands exist for refreshing one on
demand, or for adding guidance to a project that skipped it.

Two **skills** install into `.claude/skills/` (Claude Code loads them on
demand; Codex and Cursor have no skill mechanism, so their rules live in the
guidance text instead):

- **`ef-page-events`** — authoring Drawflow page-event and funnel graphs:
  split tests, redirects, "load the white page unless…", conditions, popups.
- **`ef-stats`** — reading analytics correctly. Mostly it exists to prevent
  four specific wrong answers: a timezone-shifted day boundary read as a real
  drop, an unavailable metric reported as zero, the resolver's extra metrics
  treated as requested, and a split test called before the server's sample
  floor is met.

The skills are kept current the same way the guidance is: a project that has
`.claude/skills/` gets new and updated skills on the next command after an
upgrade. This matters because the two reference each other — a refreshed
`CLAUDE.md` tells the agent to use the `ef-stats` skill, so shipping the
sentence without the file would point it at something that isn't there. Only
what is missing or actually different is written.

Skip the lot with `ef init --no-claude`; a project that opted out is never
given these files behind your back — no `.claude/skills/` means no skills, and
the refresh leaves it that way.

> Claude Code enumerates `.claude/skills/` when a session starts. A skill that
> arrives mid-session (from an `ef pull`, say) is on disk and readable, but will
> not appear in the session's skill list until it restarts.

## Analytics (`ef stats`)

`ef stats` reads the same analytics API the web dashboard uses, through the same
per-brand credential as every other command. So the numbers are always *this*
brand's — the key in `.ef/auth` does not open any other — and there is no
account-wide roll-up to ask for.

```bash
ef stats                                             # last 7 days, headline metrics
ef stats --range today
ef stats --metrics revenue,net_revenue,aov,cpc --range 30d
ef stats --from 2026-08-01 --to 2026-08-18 --tz Europe/Bucharest
ef stats by country --metrics sessions,revenue --limit 10
ef stats by day --metrics revenue --range 14d
ef stats split 321                                   # per-variant + significance
ef stats --json | jq '.metrics[] | {metric, value}'
```

**Days are counted in a timezone, and the CLI always sends one.** Left to
itself the API falls back to `America/Los_Angeles` — not to the brand's own
zone — which silently shifts every day boundary for a brand outside that
offset, with nothing in the output to show it happened. `ef stats` sends this
machine's zone by default; override per-run with `--tz`, or per-project by
adding `analyticsTz` to `.ef/config.json`.

Two smaller things worth knowing:

- **The metric list is discovered, not fixed.** `ef stats metrics` asks the
  server what this brand can report on. A brand's plan modules and your role
  permissions both filter it, so a metric that exists for one brand may simply
  be absent for another. Requesting one that isn't available reports it as
  unavailable rather than as zero.
- **A response can contain metrics you didn't request.** The server resolves
  dependencies — ask for `conversion_rate` and it also computes `sessions` and
  `customers`. `ef stats` reports back the selection you asked for, in the
  order you asked for it; `--raw` shows everything the server sent.

## Drift detection (`ef diff`)

`ef diff` compares the SHA-256 of every local file against the baseline the
last `pull`/`push` recorded in `.ef-state.json`. Use it before a noisy push
to see exactly what would land on the server.

```bash
ef diff                       # full report
ef diff pages/                # restrict to one folder
ef diff --summary             # just counts
ef diff --json | jq '.[] | select(.status == "dirty")'
```

Statuses:

| Status | Meaning |
| --- | --- |
| `clean` | Local hash matches the baseline. Nothing to do. |
| `dirty` | Local hash differs — `ef push` will send these. |
| `local-only` | Has a state entry but the file lost its efmeta header (formatter stripped it, etc.). Push will treat as new. |
| `server-newer` | Server's `updated_at` is later than the recorded baseline. Pull first or push will hit a 409. |
| `unknown` | File is in a known kind dir (`pages/`, `components/`, …) but has no state entry. Almost always a brand-new file. |

## Incremental pulls (`ef pull --since`)

For large brands, `ef pull` can take a while because it lists every page,
component, script, and asset. If you only need updates since the last sync,
pass `--since <iso>`:

```bash
ef pull --since 2026-05-10T00:00:00Z          # all kinds with sync-delta
ef pull pages --since 2026-05-10T00:00:00Z    # only pages
ef pull assets --since 2026-05-10T00:00:00Z   # only assets
```

The server only exposes a `sync-delta` endpoint for pages and assets today.
Components, scripts, variables, and templates always do a full pull — you
can still combine `ef pull --since` with `ef pull components` in two
commands when you only want components and pages refreshed.

## Dry-run pushes (`ef push --dry-run`)

`--dry-run` reads every file you would push, classifies it by efmeta state,
and prints the planned action without making any API call or disk write.
Safe to run from a CI prechecks step:

```bash
ef push --all --dry-run --json | jq '.planned[] | select(.action == "create")'
```

## Concurrency

`ef pull pages|components|scripts|assets` (and full `ef pull`) issue HTTP
requests with bounded concurrency (default 8). This makes a thousand-page
brand pull about 8× faster vs. the previous serial loop, while still
keeping the per-IP rate limit happy.

## Conflict handling

`ef push` sends `expected_revision_id` for pages and components — same as the
VS Code extension. If the server has been updated since the last pull/push,
the request returns HTTP 409 and the CLI exits with code `4`. Resolve it by:

```bash
ef pull pages/about-us.ef    # pull the server version
# … review, merge your edits back in …
ef push pages/about-us.ef    # try again
```

Or, if you're sure you want to overwrite the server, pass `--force`:

```bash
ef push pages/about-us.ef --force
```

## Draft vs publish (`ef push`)

`ef push` **publishes** by default — the change goes live immediately, the same
as clicking **Publish** in the editor. To save a draft instead (a server
revision that isn't live until it's published), pass `--draft`:

```bash
ef push pages/about-us.ef --draft         # save a draft, don't publish
```

A draft push says so explicitly, so it's never mistaken for a publish:

```text
✓ Pushed 1 file.
! Saved as DRAFT — not live on the site yet.
  Publish in the app, or re-run with --direct to publish now.
```

To make **draft** the default for a folder, set `"saveMode": "draft"` in
`.ef/config.json` (or `ef init … --save-mode draft`). The effective mode and the
live-vs-draft outcome are shown under `ef push … --verbose`, and `--json`
includes a top-level `"draft"` boolean.

## JSON output for tooling

Every command takes `--json`. Output goes to stdout, all log/status messages
to stderr, so piping is safe.

```bash
ef list pages --json | jq '.[] | {id, slug, title}'
ef whoami --json
ef status --json
ef pull --json
ef push pages/about-us.ef --json
```

## Environment variables

- `EF_API_KEY` — used by `ef init` if `--api-key` is not passed and stdin is
  not a TTY (handy for CI, GitHub Actions, etc.).
- `NO_COLOR` — disables ANSI color in stderr output.
- `NO_UPDATE_NOTIFIER` / `EF_NO_UPDATE_NOTIFIER` — disables the daily
  "update available" check. (Also skipped automatically under `CI`, when stderr
  isn't a TTY, and with `--json`.)

## Compatibility with the VS Code extension

The CLI writes the **same `efmeta` headers** the extension does:

- `{{-- efmeta:{...} --}}` for `.ef` files (legacy `<!-- efmeta:{...} -->` is
  also accepted for back-compat).
- `// efmeta:{...}` for backend scripts.

A file produced by either tool is byte-identical for the same content — open
a `.ef` file in either, save it, and the meta line round-trips cleanly.

### Where they differ

By default the on-disk file layout is **identical** — both bind one folder to
one brand and write `elasticfunnels/pages/…`, `components/…`, etc. The two
differences are where credentials live and the `.ef-state.json` schema:

| Concern | VS Code extension | CLI |
| --- | --- | --- |
| Config storage | `.vscode/settings.json` (workspace) | `.ef/config.json` + `.ef/auth` |
| Brand root | `<workspace>/elasticfunnels/` | `<project>/elasticfunnels/` (same; `…/<brandId>/` only with `--sync-layout nested`) |
| `.ef-state.json` location | brand root | brand root |
| `.ef-state.json` schema | `pagesById`, `pathToPageId`, … (`version: 2`) | `pages`, `components`, … keyed by path (`version: 1`) |

**Use a separate folder per tool — this is the supported pattern, not a
workaround.** Each tool owns its own `.ef-state.json` and keeps it consistent
with the server; running the extension and the CLI against their own folders
is the clean, reliable setup.

Pointing *both* tools at the **same physical brand root** is not supported:
the two `.ef-state.json` schemas aren't interchangeable, so the tools would
overwrite each other's baseline. As a guard, each tool refuses to write a
state file produced by a newer schema version and surfaces a clear version
mismatch instead of silently corrupting it. If you've ended up sharing a
folder, split them back into separate folders and `pull` in each — the server
is the source of truth, so nothing is lost.

## Safety notes

- **API key storage**: written to `.ef/auth` (chmod `0600` on Unix; on Windows
  the file inherits parent ACLs — store keys somewhere you trust). Never
  written anywhere else, never echoed to stdout/stderr — there's a regression
  test for this in `test/secrets.test.ts`.
- **Path traversal**: every server-supplied path goes through
  `safeJoinBrandRoot`, which normalizes slashes and refuses to write outside
  the brand root. See `test/paths.test.ts`.
- **Atomic writes**: `writeFileAtomic` writes a sibling `.tmp-…` file then
  renames. On any failure the temp file is unlinked so the user's tree never
  fills with crash artefacts.
- **Optimistic concurrency**: pushes send `expected_revision_id`. On HTTP 409
  the CLI exits 4 without writing anything to disk and never updates the
  baseline in `.ef-state.json`, so a retry-after-pull works cleanly.
- **`.gitignore`**: `.ef/` is auto-added on `ef init` when a Git repo is
  detected, so an API key cannot accidentally be committed.
- **Non-TTY safety**: `ef init` without `--api-key` and without `$EF_API_KEY`
  exits with code 2 (validation) instead of hanging when stdin is piped or
  redirected (CI, scripts).
- **Push hygiene**: `ef push --all` skips dotfiles (`.ef-state.json`, `.git`,
  …), `node_modules`, editor backups (`*~`, `.swp`, `.swo`), and our own
  `.tmp-…` artefacts at every depth.

## Contributing & releases

The release flow (pre-publish checklist, cutting a version, dist-tags) lives in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Support

Bug reports and feature requests:
[GitHub issues](https://github.com/elasticfunnels/cli/issues) or
`support@elasticfunnels.io`.

## License

Source-available. This repository is published for transparency and security
review. See [`LICENSE`](./LICENSE) for the full terms — in short: read,
install via npm, build locally, no redistribution, no derivative CLIs, no use
to operate a competing service.
