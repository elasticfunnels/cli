# ElasticFunnels — Identity & Docs TODO

## Planning docs
- `TODO.md` (this file) — identity bugs + documentation gaps.
- `TODO-remove-efmeta.md` — drop the in-file `efmeta` line; identity from `.ef-state.json` only.
- `TODO-ef-watch.md` — `ef watch` auto-push, and the `ef config`/saveMode-default fix.

## CLI UX fixes (tracked in the task list)
- [x] **`ef components create` 422** — sent `code: ''` → Laravel `ConvertEmptyStringsToNull` → `null`
  → "The code must be a string." Now passes the real code (`componentCommands.ts`, `sync.ts:499`).
  Regression test in `test/component-create.test.ts`.
- [x] **`ef components push <codeOrPath>`** added (mirrors `ef scripts push`); resolves a bare code to
  `components/<code>.ef` with a clear "create it / pull first" error.
- [ ] **`ef config get/set`** — flip an existing project's `saveMode` to `direct` without re-init.
- [ ] **Colored request loader** — block-bar shown for all API requests.

---

Findings from the cross-repo investigation (CLI + VS Code extension + Laravel backend + Editor.vue + template runtime). Two workstreams:

- **Part 1 — File→ID integrity bugs** (the "component got another component's id" incident)
- **Part 2 — Documentation gaps** (generated `CLAUDE.md` is missing the `.ef` template syntax that the `.cursor` rules document)

Repos referenced (paths as found locally):
- **CLI** — `~/Work/elasticfunnels-cli`
- **VS Code extension** — `~/Work/elasticfunnels/vscode-extension`
- **Backend (Laravel) + Editor.vue + `.ef-docs/`** — `~/Work/elasticfunnels`
- **Template runtime + `.cursor/rules`** — `~/Work/website/src/services/TemplateEngine`, `~/Work/website/.cursor/rules` (rules also exist under `~/Work/elasticfunnels/.cursor`). _Confirm which app checkout is canonical — `website` and `elasticfunnels` look like two clones/branches of the same app._

---

## Part 1 — File→ID integrity (crossed component ids)

**Symptom:** a component file became associated with a *different* component's server id (different codes/slugs, crossed ids), so saving one overwrote the other.

**Root cause (unifying):** identity is keyed on **mutable, non-unique** fields (`code`/`name`/`slug`) at several layers, while only the numeric `id` is safe. Four independent defects, each able to cross ids. Fix the backend first (foundation), then per-tool guards.

### P0 — Backend: `code` is non-unique + `is_numeric` id/code conflation  ⟵ root enabler
Repo: `~/Work/elasticfunnels/Modules/PageComponents`
- [ ] Add a real DB uniqueness constraint `unique(brand_id, code)` to `brand_page_components` (migration `2023_11_17_182639` currently makes `code` `nullable`, no unique index). First de-dupe existing rows and decide soft-deleted handling.
- [ ] Make `code` non-null with a generated default (the model's auto-`getUniqueCode()` is currently commented out — `BrandPageComponent.php:99-104`).
- [ ] Stop the `is_numeric($x) ? where('id',$x) : where('code',$x)` heuristic for the `{component}` route param (used in `PageComponentsController` show:144 / update:170 / clone:375 / destroy / usage, and `ComponentsEditorController` index:32 / update:74 / resolveComponent:223). A component whose **code is numeric** resolves to a *different* component's id; **duplicate codes** resolve non-deterministically (no `orderBy`). Options: dedicated `?by=code` param, or reject numeric codes, or a resolver that errors on ambiguity.
- [ ] Remove `->orWhere('id', $code)` from `BrandPageComponent::findByCode` (`:86-92`).
- [ ] Re-check clone/copy/restore paths — they bypass the request-validator uniqueness and `getUniqueCode()` ignores soft-deleted rows, so a clone can collide with a trashed component's code.
- [ ] **Pages**: lower priority — write paths key strictly on numeric `id` (`PageEditorController:138`) and `variant_slug` has a real `unique(brand_id, variant_slug)`. But plain `slug` is **not** DB-unique and `BrandPage::findBySlug` is global `->first()` (`:216`); guard before any future slug-based write path is added.

### P1 — CLI: no copy-detection on push, silent overwrite on pull
Repo: `~/Work/elasticfunnels-cli/src/sync`
- [ ] **Push copy-detection.** `pushComponentFile`/`pushPageFile` (`sync.ts:447-495`, `:346-`) trust `meta.id` and **never compare `meta.path` to the actual path**. `cp components/a.ef components/b.ef` → `b.ef` keeps id A → `ef push b.ef` overwrites **component A**. The `path` field is written (`:190`, `:467`) but unused. Mirror the extension's guard: if `meta.path` is set and ≠ current rel, treat as a NEW entity (strip id → create), or refuse with a clear error.
- [ ] **Pull collision guard.** `pullAllComponents`/`pullAllPages` loop with no de-dup (`sync.ts:208-214`, `:167-176`). `relPathForComponent` = `components/${code || name || component-${id}}.ef` (`paths.ts:24-27`); two entities with the **same code** (now possible — see P0) or null codes resolve to one file and the second `writeFileAtomic` silently clobbers the first, shadowing one id. Detect two ids → one path; disambiguate the filename (e.g. `code (id).ef`, infra already parses `name (id).ef`) and `log.warn` instead of overwriting.
- [ ] **Cross-tool filename divergence.** CLI uses `code` for component filenames; the extension uses `slugify(name)` (see P1-ext). The two tools place the same component in **different files** on a shared folder. Decide one convention (prefer `code`/id) and align both.
- [ ] Optional: on push, if `state.pathToId` disagrees with the file's `meta.id`, warn rather than trusting either silently.

### P1 — VS Code extension: filename from `name` → state crossing  ⟵ strongest match for the incident
Repo: `~/Work/elasticfunnels/vscode-extension/src/sync`
- [ ] `getComponentFileUri` derives the path from `slugify(component.name)` and **never uses the unique `code`** (`diskSyncService.ts:604-608`). Two components with different codes but colliding name-slugs (case/whitespace/punct/accent, or duplicate display names) collide onto **one** file. Switch to `code`/id-based filenames.
- [ ] `setComponent`/`setPage` blindly overwrite `pathToComponentId[path]` and orphan the prior id (`stateFile.ts:552-567`). Make them refuse or reassign when a *different* id already holds the path.
- [ ] `guardEfMetaAgainstState` "auto-recovers" by **rewriting a file's efmeta id to the other component's id** from corrupted state (`diskSyncService.ts:3285-3323`), then pushes A's content to B's id (`:4973-4974`). Don't rewrite an id to a different entity without copy/path-mismatch detection.

### P2 — Editor.vue / AI agent: patch routed by external `target_id`
Repo: `~/Work/elasticfunnels/Modules/Pages/resources/views/Pages`
- [ ] Native open/switch/save is **safe** (keyed by immutable `id`: `Editor.vue:5215,5323`). The risk is the **AI patch pipeline**: it routes a staged patch by an externally-supplied `target_id` without reconciling against the patch's `file_path`/`code` (`AiAgent.vue:2252-2319`, `Editor.vue:3535-3537,3486-3492`). Reconcile `target_id` ↔ `file_path`/`code` before staging; reject on mismatch.
- [ ] Make the `original_html` baseline check unconditional (currently only runs when the target tab is active — `Editor.vue:3543-3569`).
- [ ] Fix prefix bug: `handleAiOpenTarget` builds `component:${id}` but `getModel` only recognizes `comp:` (`Editor.vue:3452` vs `:5215`); also leaks an empty `models['component:<id>']`.

### Verification / regression
- [ ] CLI: add a test that a copied file (efmeta `path` ≠ current path) creates a NEW entity instead of overwriting the source (mirror the existing mock-server test style in `test/push-draft-warning.test.ts`).
- [ ] CLI: add a test that pulling two entities with the same derived path does not silently drop one.
- [ ] Backend: migration test that duplicate `code` per brand is rejected.

---

## Part 2 — Documentation gaps (`ef claude` / CLAUDE.md)

**What's generated:** `ef claude` (`~/Work/elasticfunnels-cli/src/commands/claude.ts`) writes a `CLAUDE.md` block. Its **Template engine** section (claude.ts:63-73) is a stub: it documents only `{{ }}` and `{{-- --}}`, then says "match the patterns in existing files" + links to docs.elasticfunnels.io. Its **Backend scripts** section (`:74-82`) only lists CLI commands.

**What exists but isn't surfaced:** the `.cursor/rules/*.mdc` (in `~/Work/website/.cursor/rules`) document the real syntax, and the runtime registers **~90 template functions + ~55 filters** (`~/Work/website/src/services/TemplateEngine/adapters/*.js`). The user specifically called out `{{ asset('...') }}`, which the stub omits — `asset` is `CoreAdapter.js:205` and appears in `elasticfunnels-ai-commands.mdc:77` (`{{ asset('/main.css') }}`) and `ef-backend-scripts.mdc:160`.

### P1 — Enrich the `ef claude` template (claude.ts) to cover what `.cursor` does
Add these sections (port/condense from the rules + runtime). Source rules: `ef-template-engine.mdc`, `ef-forms.mdc`, `ef-variants.mdc`, `ef-file-safety.mdc`, `ef-backend-scripts.mdc`, `elasticfunnels-ai-commands.mdc`.

- [ ] **Backend directives**: `@if/@elseif/@else/@endif`, `@foreach(item in arr)…@endforeach`, `@set(x = …)`, `@component("code", { … })`, `@extends("slug")` + `@block("name")…@endblock`. Word operators: `eq neq lt lte gt gte`, `and or !`.
- [ ] **Interpolation + filters**: `{{ path }}`, `{{ x | filter:arg }}`. Document the common filters explicitly — `raw`, `default`, `slice`, `date`, `currency`, `number_format`, `truncate`, `truncatewords`, `upper/lower/title/capitalize`, `json`, `timeago`, `yesno`, `replace/replace_var`, `strip_tags`, `trim`, `length/size`, `first/last`, `sort/unique/reverse/join`, `round/floor/ceil/abs`, `minus`, `in`, `url_encode`, `t`, `savings`. (Full list: `registerFilter(...)` across the adapters.)
- [ ] **Template functions** (the `{{ func(...) }}` calls) — at minimum the ones authors hit: **`asset('/path')` → brand CDN URL** (the one you flagged), `buy(code)`, `upsell/downsell/decline(code)`, `getProduct(s)/getProductByCode`, `getOrders/getOrder/getCustomer`, `getCourse(s)`, `getBlog(s)/articles`, `getSubscription(s)`, `date`, `t/getTranslation`, `getBrand`, `get/setSessionItem`, `dump`, `sum`. (Full ~90: `registerFunction(...)` across `adapters/*.js`.)
- [ ] **Template context** authors can reference: `var.*` (brand variables), `request.is_mobile/is_tablet/query/is_customer/referer/merchant_code`, `query.*`, `page`, `orders`.
- [ ] **Frontend reactive layer** (currently entirely absent): `<template-if data-condition>`, `<template-foreach data-each>`, `<template-vars>`, `<template-set>`, `<template-component>`; `[[ expr ]]` output; `data-ef-text`/`data-ef-html`; `@click`/`data-ef-on`; `:attr` bindings; `data-template-value`; `window.efScope` + `notifyScopeUpdated()`. **Key distinction: backend uses `{{ }}`, frontend uses `[[ ]]`.**
- [ ] **Forms → collections**: write a normal `<form>` with named inputs; the backend auto-creates a collection and rewrites `action`/`data-collection*` on save. Optional `COLLECTION_CODE` placeholder. **Don't invent collection codes.** (from `ef-forms.mdc`)
- [ ] **Variants**: subfolder-per-base-slug layout, `slug` (active) vs `variant_slug` (inactive), promote/separate; don't hand-create variant files. (from `ef-variants.mdc`)
- [ ] **Backend scripts (richer)**: read-only globals, actions (session/cookies, redirect, template vars, custom response, headers), data functions, outbound HTTP, limits, logging, cross-file imports, `asset()`. (from `ef-backend-scripts.mdc`)
- [ ] **Rename/delete/create semantics** for the CLI specifically (the rules describe the *extension's* rename detection; the CLI story differs — `ef push`/`ef pull`, and the copy/efmeta caveats from Part 1).

### P2 — Make the docs single-sourced (avoid drift)
- [ ] The ~90 functions / ~55 filters will drift from any hand-written copy. Consider generating a reference table from the adapters' `registerFunction`/`registerFilter` calls, consumed by both `ef claude` and the `.cursor` rules.
- [ ] `ef-template-engine.mdc:146` cross-references `.ef-docs/templates/BACKEND_TEMPLATE_ENGINE.md` / `FRONTEND_TEMPLATE_PROCESSOR.md`, which exist in `~/Work/elasticfunnels/.ef-docs/templates/` but **not** in `~/Work/website` — so the relative link is broken depending on which repo the rule loads in. Fix the path or co-locate.
- [ ] Decide whether `ef claude` should also emit `.cursor/rules/*.mdc` (Cursor) and/or `AGENTS.md`, not just `CLAUDE.md`, so non-Claude agents get the same guidance.

---

## Appendix — "rename → empty content" (likely a misunderstanding)
From session `d8ce963a-…` in `~/Work/asperdigital/advertise`: user cloned `https://clevernhealthy.com/wellness-trick` into an `.ef` page and later said "page for clean seems empty." The source was a **page-builder page** (user noted "it won't work because it's a page builder page"), which has **no editor HTML** to clone — so an empty editor body is expected, not an identity/sync bug. **Action:** none unless reproduced; if it recurs with a normal editor page, re-investigate against the Part 1 copy/efmeta paths.
