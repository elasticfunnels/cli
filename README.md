# `ef` — ElasticFunnels CLI

A folder-scoped command-line tool for ElasticFunnels. Built for Claude Code,
Codex, scripts, CI pipelines, and humans.

```bash
$ ef init                    # bind this folder to a brand
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
├── elasticfunnels/   # default sync root
│   └── 123/          # brand id
│       ├── pages/
│       │   ├── home.ef
│       │   └── pricing.ef
│       ├── components/
│       │   └── header.ef
│       ├── scripts/
│       │   └── welcome-email.js
│       ├── assets/
│       │   └── images/logo.png
│       ├── variables.json
│       └── .ef-state.json   # baselines (content hashes, revisions)
└── .gitignore        # `.ef` added automatically by `ef init`
```

## Auth model

- The CLI uses the same `EF-Access-Key` header the dashboard and the VS Code
  extension use. Each (user, brand) pair has its own API key — pick yours up
  from the brand's settings page → API.
- `ef init` stores the key in `.ef/auth` (chmod 600), the rest of the config
  in `.ef/config.json`. `.ef/` is added to `.gitignore` automatically when a
  Git repo is detected.
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
| `ef init` | Bind this folder to a brand. Interactive or non-interactive (`--api-key`, `--brand-id`). Errors if already bound; warns + confirms if the folder isn't empty (`--force` to skip). |
| `ef reset` | Unbind this folder — remove `.ef/`. |
| `ef whoami` | Print the active project root, brand, API URL, key prefix. |
| `ef status` | Connection check, last-pull timestamp, entity counts. |
| `ef list <kind>` | List pages \| components \| assets \| scripts \| folders \| templates. |
| `ef preview <slugOrId>` | Print editor preview URL (uses draft `revision_id` when present). `--live` for public site URL only. |
| `ef get <kind> <idOrSlug>` | Fetch one entity. Defaults to printing HTML body; `--json` for full payload. |
| `ef pull` | Full sync (pages + components + scripts + assets + variables). |
| `ef pull <target>` | Targeted pull, e.g. `ef pull pages` or `ef pull pages/about-us.ef`. |
| `ef pull --since <iso>` | Incremental pull using the server's sync-delta endpoints (pages and assets only). |
| `ef push <paths…>` | Push specific files. Uses optimistic concurrency (`expected_revision_id`). |
| `ef push --all` | Push every file under the brand root. |
| `ef push --dry-run` | Print what would be pushed without making any API calls or disk writes. |
| `ef diff [paths…]` | Show local-vs-baseline drift across the brand root (or restricted to paths). |
| `ef pages list` | List pages (alias `ef pages ls`; same output as `ef list pages`). |
| `ef pages create <slug>` | Create a new page. |
| `ef pages publish <slug>` | Publish the latest editor draft for a page. |
| `ef pages preview <slug>` | Print preview + live URLs (draft revision from editor when present). |
| `ef pages duplicate <slug>` | Duplicate a page. |
| `ef pages delete <slug>` | Delete a page. |
| `ef components create <code>` | Create a new component. |
| `ef components delete <codeOrName>` | Delete a component. |
| `ef scripts create <code>` | Create a new backend script. |
| `ef scripts pull <codeOrId>` | Pull one backend script. |
| `ef scripts push <pathOrCode>` | Push one backend script. |
| `ef scripts get <codeOrId>` | Print script body or `--json` payload. |
| `ef scripts delete <codeOrId>` | Delete a script (and its local file). |
| `ef assets upload <localPath>` | Upload a local file. `--as <remotePath>` to override. |
| `ef assets pull <remotePath>` | Pull one asset. |
| `ef assets delete <remotePath>` | Delete an asset. |
| `ef variables get` | Print brand variables JSON. |
| `ef variables pull` | Write `<brandRoot>/variables.json`. |
| `ef variables push [--file]` | Push the variables JSON to the server. |

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

## Compatibility with the VS Code extension

The CLI writes the **same `efmeta` headers** the extension does:

- `{{-- efmeta:{...} --}}` for `.ef` files (legacy `<!-- efmeta:{...} -->` is
  also accepted for back-compat).
- `// efmeta:{...}` for backend scripts.

A file produced by either tool is byte-identical for the same content — open
a `.ef` file in either, save it, and the meta line round-trips cleanly.

### Where they differ

The CLI is **multi-brand-aware**; the extension binds one VS Code workspace
to exactly one brand. As a result the on-disk layouts diverge:

| Concern | VS Code extension | CLI |
| --- | --- | --- |
| Config storage | `.vscode/settings.json` (workspace) | `.ef/config.json` + `.ef/auth` |
| Brand root | `<workspace>/elasticfunnels/` | `<project>/elasticfunnels/<brandId>/` |
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
