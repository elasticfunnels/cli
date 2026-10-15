# ef CLI: tasks

The one list of work for this repo. Add before you start, tick only what is verified (test, live check), with the commit.

## Waiting on the owner

## To do
- [ ] 2026-10-14 Template tooling gaps (owner "fix all gaps", kit builds): `ef pages settings --requires-login on|off --redirect-url`, `ef shipping-profiles list|get|create|update|assign`, `ef collections delete`, `ef tags delete #id` + --force off a terminal; agent block + README. App side on ~/Work/elasticfunnels branch fix/template-tooling-gaps (shipping API fixes, products/all shipping_profile_id). Left: app deploy, then live run on brand 551, release.
- [ ] **Sync CLAUDE.md + .claude/rules with the brand** (owner, 2026-10-13) · user part of CLAUDE.md (outside the ef block) + `.claude/rules/**`; rides along with `ef push`/`ef pull`, `ef claude sync|pull|push` on demand; `ef init` restores missing files, keeps differing local ones and warns. Conflicts: base_hash → 409 → 3-way merge (`threeWayMerge`), markers + exit 4. Backend endpoint in ~/Work/elasticfunnels (TASKS.md there). Built: CLI tests 8/8 (fake server with the backend's 409 semantics; full suite 346/346), backend ab4dd371a + fea39a4c1 (13/13). Shipped dormant in CLI 0.20.0 (2026-10-13; live API answers 404 on /agent-files, so pull/push skip it silently). Left: deploy backend + migrate, then one live round trip (push on one folder, `ef init` in a fresh one).

## Done
- [x] 2026-10-15 Offline pages: `ef push`, `ef preview`, `ef pages preview|publish` no longer print a dead preview link for an offline page; they say it is offline and give the publish command (owner). b68db02. Checked: npm test 392/392 incl. 5 new (offline-page-preview.test.ts); live `ef preview blog/ecommerce-sales-funnel` (offline) prints the warning, a published page still prints both URLs. Not released to npm yet.
- [x] 2026-10-14 General page rules from the template-library fix into the agent block (owner): e470bcf, version 0.21.0 dad58da (NOT published; f3d02bb + ef folders also unpublished). Checked: npm test 372/372 incl. 3 new guidance tests, lint clean, regenerated into ef-templates (adceb78). Refresh never downgrades a newer block, but installed 0.20.0 CLIs still do until 0.21.0 is published.
