# TODO — Remove `efmeta` entirely (CLI + VS Code extension)

Goal: stop embedding the `{{-- efmeta:{...} --}}` / `// efmeta:{...}` identity line in `.ef`/`.js`
files. Track file→server-id identity **only** in `.ef-state.json`.

## Why
- **IDE linter/formatter churn.** Session `d8ce963a-…` (asperdigital/advertise): editing
  `pages/wellness-support.ef` repeatedly failed with *"File has been modified since read, either
  by the user or by a linter"* — *"The IDE linter keeps rewriting the file after each edit."* The
  in-file `efmeta` first line is a prime trigger (formatters reflow/move it; a watcher may re-stamp it).
- **Kills a whole class of identity bugs** (see `TODO.md` Part 1): copy-trample on push
  (`sync.ts` has no `meta.path` check), and the extension's `guardEfMetaAgainstState` rewriting a
  file's id to a *different* entity. No in-file id ⇒ a copied file has no identity ⇒ treated as new
  (safe), and there is one source of truth instead of two that can disagree.
- **Less cognitive load / fewer footguns** — removes the entire "never touch the efmeta line" rule
  surface from `CLAUDE.md` and the `.cursor` rules.

## Decisions to lock first (blockers)
- [ ] **D1 — Identity durability.** `.ef-state.json` becomes the *only* identity. Pick one:
  - (Recommended) **Split a slim, committed identity manifest** (path → `{id, type}` only, stable,
    diff-friendly) from the volatile sync cache (content hashes, `serverUpdatedAt`, `revisionId`,
    which stay local/gitignored). Manifest travels with git; cache is disposable.
  - Or commit the whole `.ef-state.json` (simpler, but noisy git diffs on every pull/push).
  - Or keep it local-only and require `ef pull` after every clone (worst for teams).
- [ ] **D2 — Untracked-file push behavior** (file present, no state entry, no efmeta): create-new,
  or resolve id from server by code/slug? Resolving reintroduces the backend code→id ambiguity
  (`TODO.md` Part 1 / P0). Default to **create-new + warn**, with an explicit
  `ef push <file> --as <id>` / `ef link <file> <id>` escape hatch.
- [ ] **D3 — Rename handling (CLI has no file watcher).** Options: explicit `ef mv <old> <new>`
  (updates state + server slug/code) and/or best-effort detection on `ef push` (old path gone +
  new untracked file with matching content hash ⇒ move the state entry). Recommend both.
- [ ] **D4 — Transition strategy.** Both tools must agree. Proposed: bump `.ef-state.json` version;
  during a deprecation window read legacy efmeta **only as a fallback** when state has no entry,
  but never write it; then drop reading entirely.

## Phase 0 — Diagnose the churn (confirm the fix lands)
- [ ] Reproduce in Cursor: edit a `.ef` body and capture what rewrites the file — the EF extension's
  `onDidChange`/save handler re-stamping efmeta, vs a generic format-on-save (Prettier/HTML).
- [ ] If it's format-on-save on the *body*, removing efmeta helps but won't fully stop body reflow —
  also document a `.prettierignore`/`files.associations` recommendation for `elasticfunnels/**`.
- [ ] Confirm whether the extension re-writes the file (and the efmeta line) on every change.

## Phase 1 — Make state authoritative & durable (per D1)
- [ ] Implement the chosen manifest/cache split (or commit strategy) in CLI `src/sync/stateFile.ts`.
- [ ] Ensure `.ef-state.json` (or the slim manifest) is **not** gitignored at the brand root; add a
  `.gitignore` rule for the volatile cache only. (Today only `.ef/` is ignored — brand-root state is
  already committable.)
- [ ] Mirror the same split/scheme in the extension's `stateFile.ts` so both tools agree.

## Phase 2 — CLI: stop writing/reading efmeta
Touchpoints (from grep of `~/Work/elasticfunnels-cli/src`):
- [ ] `src/sync/sync.ts` — **pull** stops wrapping bodies: `pullPage` (`:139-151`),
  `pullComponent` (`:181-194`), `pullScript` meta line (`:232`). Write body only; record path→id in state.
- [ ] `src/sync/sync.ts` — **push** stops reading/rewriting efmeta: `pushPageFile` (`:353`, `:369-380`,
  `:414-422`), `pushComponentFile` (`:454`, `:467-477`, `:500-505`), script meta (`:548`, `:574`).
  Resolve id from `state.getByPath(...)`; implement D2 (untracked) + D3 (rename).
- [ ] `src/sync/efMeta.ts` — retire `serializeEfMeta`/`withEfMeta`; keep a `stripLegacyEfMeta(text)`
  reader for migration + the D4 fallback window, then delete the module. Same for `parseScriptMeta`
  (`sync.ts:658`) and the `serializeEfMeta` re-export (`sync.ts:674`).
- [ ] `src/commands/diff.ts` (`:134-148`) — drift status from **state only**; drop the
  "has efmeta / efmeta header missing / no efmeta" branches.
- [ ] `src/commands/push.ts` (`:243`) — `predictAction` resolves create-vs-update from state, not efmeta.
- [ ] `src/api/client.ts` (`:596`) — reword the "try `ef pull` to refresh efmeta" hint.
- [ ] **Migration command** `ef migrate strip-efmeta` (or fold into `ef pull`): for each tracked file,
  ensure state has its path→id, then rewrite the file without the leading efmeta line. Idempotent;
  `--dry-run`; refuse if a file's efmeta id disagrees with state (surface, don't auto-pick).
- [ ] `src/commands/claude.ts` (`:41-56`) — replace the "CRITICAL: the efmeta line" section with a
  short "identity lives in `.ef-state.json` — don't edit it; don't hand-create files, use `ef pull`."
- [ ] Tests: pull writes no efmeta; push resolves id from state; copied file (new path) creates a new
  entity (not a trample); rename via D3 keeps identity; migration strips efmeta idempotently;
  legacy-efmeta file still pushes during the fallback window.
- [ ] Update `README.md` (efmeta / "Compatibility with the VS Code extension" sections).

## Phase 3 — VS Code extension: stop writing/reading efmeta
Repo `~/Work/elasticfunnels/vscode-extension/src/sync` (line refs from the earlier audit):
- [ ] `diskSyncService.ts` — drop `makeMeta` (`:3151-3163`) / `buildScriptEfMetaLine` (`:3169`) from
  the write path; write body only.
- [ ] Remove `guardEfMetaAgainstState` (`:3285-3323`) — the auto-rewrite-id-from-state behavior that
  finalized crossed ids. Identity comes from state path→id, full stop.
- [ ] Re-base the copy-detection (`:4728-4751`) on state path mapping instead of `meta.path`.
- [ ] `efMeta.ts` / `parseScriptEfMeta` (`:3815`) — keep only as a migration/fallback reader, then remove.
- [ ] On-save/rename/copy handlers resolve identity via `stateFile.ts` (`pathToComponentId` /
  `pathToPageId`); fix the underlying filename-from-`name` bug (`getComponentFileUri:604-608`) so
  paths are stable keys (use `code`/id) — otherwise state path keys are still collision-prone.
- [ ] Extension-side migration: strip efmeta on next sync; reconcile state first.

## Phase 4 — Cross-tool rollout
- [ ] Ship behind the `.ef-state.json` version bump (D4); both tools: **don't write** efmeta, **read**
  legacy efmeta only as a fallback when state lacks the path.
- [ ] Release order/notes so a mixed-version pair (one still writing efmeta) doesn't corrupt state;
  the no-write side must tolerate (and strip) a stray efmeta line it encounters.
- [ ] After the window, drop legacy-efmeta reading from both tools.

## Phase 5 — Cleanup
- [ ] Delete `efMeta.ts` (both repos) and dead code; remove the efmeta sections from `CLAUDE.md`
  generator output, `README.md`, and `.cursor/rules/ef-file-safety.mdc`.
- [ ] Verify `ef diff` / `ef status` / drift detection rely solely on state + content hash.

## Risks & mitigations
- **State loss ⇒ identity loss** (no in-file fallback). → D1 slim committed manifest; `ef pull` rebuilds
  cache; legacy-efmeta fallback during transition.
- **Duplicate entities on untracked push.** → D2 default create-new + warn + `ef link`/`--as`.
- **Rename mis-detection.** → D3 explicit `ef mv` primary, content-hash heuristic secondary.
- **Mixed tool versions.** → D4 version gate + tolerate/strip stray efmeta.
- **Filename collisions still corrupt state path-keys** (extension `name`-based paths). → fix
  `getComponentFileUri` to use `code`/id as part of Phase 3 (also in `TODO.md` Part 1).

## Net effect on `TODO.md` Part 1
Removing efmeta **supersedes** the CLI copy-detection task (P1) and the extension
`guardEfMetaAgainstState` task — there is no in-file id to trample. The **backend `unique(brand_id,
code)`** (P0) and the **extension filename-by-`code`** fix remain required, because state path-keys
and any code→id resolution still depend on stable, unique identifiers.
