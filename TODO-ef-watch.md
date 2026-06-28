# TODO — `ef watch` (auto-push on change) + saveMode-default fix

Goal: `ef watch` watches the brand root and auto-pushes changed files as they're saved, defaulting
to **direct (publish)** — so editing a `.ef` file and saving makes it live, no manual `ef push`.

Related: builds on `TODO-remove-efmeta.md` (efmeta removal removes the biggest watch-loop trigger) and
`TODO.md` (identity). Cross-link those.

---

## Part A — saveMode default for existing projects (blocks the "direct is default" expectation)

The global default is already `direct` (CLI 0.4.1), but `loadConfig` **honors an explicit
`"saveMode":"draft"`** so upgrades don't silently start publishing. Existing projects created before
0.4.1 (e.g. `~/Work/asperdigital/advertise`, brand 136) have `"saveMode":"draft"` baked into
`.ef/config.json` → they keep drafting. There is **no command to change it** today.

- [ ] **Add `ef config` command** (CLI). At minimum:
  - `ef config get [key]` — print config (or one key).
  - `ef config set saveMode <draft|direct>` — rewrite `.ef/config.json` (validate keys; refuse unknown).
  - Allow-list editable keys: `saveMode`, `apiUrl`, `syncRoot`, `syncLayout`. (`brandId`/auth via `ef init`/`ef reset`.)
- [ ] **Immediate fix for brand 136**: `ef config set saveMode direct` (or hand-edit
  `~/Work/asperdigital/advertise/.ef/config.json`) so its pushes/watch publish by default.
- [ ] Consider a one-time **upgrade notice**: when a command runs against a config with explicit
  `"saveMode":"draft"`, hint once that `direct` is now the default and how to switch. (Don't auto-change.)
- [ ] Decide whether `ef init` on an extension-configured folder should still inherit `draft` from
  `.vscode/settings.json` `elasticfunnels.saveMode` (today it does) or default to `direct`.

---

## Part B — `ef watch` command

### CLI spec
- [ ] `ef watch [paths...]` — watch the brand root (or given subpaths) and push on change.
- [ ] Mode flags (mirror `ef push`): `--direct` / `--draft` (mutually exclusive). Default = config
  `saveMode` (now `direct`). Startup banner states the effective mode **loudly** (direct = goes LIVE).
- [ ] `--debounce <ms>` (default ~400). `--initial-push` (push current drift once on start; default off —
  just watch). `--json` (stream NDJSON events for tooling). `--verbose`.
- [ ] **No `--force` in watch** — never auto-overwrite a server conflict from a background watcher.

### Watcher
- [ ] **Decision: watcher lib.** Native `fs.watch({recursive:true})` works on macOS/Windows but **not**
  Linux (no recursive) and is event-noisy; `chokidar` is the robust cross-platform choice but adds a
  dependency (CLI currently ships only `axios`+`commander`). Recommend **chokidar**; alternative is a
  small per-dir recursive-watch helper. Lock this first.
- [ ] Watch globs under brand root: `pages/**/*.ef`, `components/**/*.ef`, `templates/**/*.ef`,
  `scripts/**/*.js`, `assets/**`, `variables.json`.
- [ ] Ignore (reuse `sync`/`collectAllFiles` skip logic): dotfiles, `.ef-state.json`, `.ef-state/`,
  `.ef/`, atomic-write temp files (`*.tmp`, `*~`), editor backups, `node_modules`, OS cruft.

### Loop prevention (critical)
- [ ] `ef push` rewrites the file (today: re-stamps efmeta + adopts the server's canonical body, e.g.
  form auto-wiring). That self-write **retriggers the watcher → infinite loop.** Guard by:
  - recording the path + content-hash the pusher is about to write, and having the watcher **ignore the
    next change event** whose hash matches (or briefly suppress that path); and/or
  - comparing the changed file's hash to `.ef-state.json`'s last-pushed hash and skipping no-ops.
- [ ] **Synergy with efmeta removal**: once efmeta is gone and "adopt canonical body" is opt-in, push no
  longer rewrites unchanged files, so the loop guard mostly handles only server-side rewrites
  (form auto-wiring, normalization). Note the dependency.

### Conflict & safety handling
- [ ] On HTTP 409 (revision conflict): **do not auto-force.** Log a clear warning, skip the file, suggest
  `ef pull <file>`; optionally mark it "conflicted" and retry after the next change/pull.
- [ ] On other push errors: log, keep watching (don't crash the whole watcher for one file).
- [ ] Debounce so half-written/burst saves don't push a partial file.
- [ ] **Deleted file**: do **not** auto-delete the server entity — log "deleted locally; use
  `ef <kind> delete` to remove on the server."
- [ ] **New file**: push as create (subject to `TODO-remove-efmeta.md` D2 untracked-file behavior).
- [ ] **Rename**: tie into `TODO-remove-efmeta.md` D3 (explicit `ef mv` and/or content-hash detection)
  so a rename doesn't create a duplicate.

### UX / output
- [ ] Startup banner: brand, effective mode (direct/draft, with a "→ LIVE" warning for direct), watched
  globs, ignore note, "Ctrl-C to stop."
- [ ] Per-event log: `→ pushing pages/x.ef (direct)…` then `✓ published` / `! saved as draft` /
  `✗ conflict — run ef pull pages/x.ef`.
- [ ] Clean shutdown on SIGINT/SIGTERM (close watcher, flush pending debounced pushes or cancel them).
- [ ] `--json`: one NDJSON object per event (`{event, path, kind, mode, action|error, ts}`).

### Implementation sketch
- [ ] `src/commands/watch.ts` + `registerWatchCommand` in `src/extension.ts`.
- [ ] Reuse `buildSyncContext`, `classifyAbsPath`, `pushPageFile`/`pushComponentFile`/`pushScriptFile`/
  `pushAssetFile`, and the draft/direct resolution from `push.ts`.
- [ ] Debounce map (path → timer); loop-guard set (path → expected-hash).
- [ ] If chokidar is chosen: add dep + update `package.json`/lockfile; ensure it's in the published
  `files`/runtime deps.

### Tests
- [ ] Change a file → exactly one push fires after debounce (no loop from the push's own write).
- [ ] Burst writes (temp+rename) coalesce to one push.
- [ ] 409 conflict → file skipped with warning, watcher keeps running.
- [ ] `--direct` vs `--draft` vs config-default resolution.
- [ ] Ignored files (`.ef-state.json`, temp) never trigger a push.
- [ ] SIGINT shuts down cleanly.

### Docs
- [ ] README: `ef watch` section (modes, loop/conflict behavior, "direct = live on save").
- [ ] `ef claude` generator: mention `ef watch` in the CLI workflow section.

---

## Open decisions (lock before coding)
- [ ] Watcher library: chokidar (recommended) vs native recursive helper.
- [ ] Loop-guard mechanism: hash-match ignore vs path-suppress window vs both.
- [ ] Does `ef watch` default `--initial-push` on or off? (Recommend off; suggest `ef push --all` first.)
- [ ] Ordering vs `TODO-remove-efmeta.md`: ship `ef watch` with the loop-guard now, or after efmeta
  removal makes self-writes rare? (Watch is usable now with the guard; cleaner after.)
