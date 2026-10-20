# ef CLI: tasks

The one list of work for this repo. Add before you start, tick only what is verified (test, live check), with the commit.

## Waiting on the owner

## To do
- [ ] 2026-10-20 Kit customise P3 (~/Work/elasticfunnels/_dev/kit-customize/PLAN.md): `ef context pull|missing|facts set|brief set`, `ef assets add|sync-drive` (TS port of launch-accelerator drive_fetch.py + docx2md.py, output identical on the sample docx), `ef images generate` (price first, --yes, --max-credits), skill `kit-customize`, agent block, `/agent` exports for the runner. Branch feat/kit-context-p3; npm test 375/375 against a mock of the P1 ai-context API. Left: P1 endpoints live, one live pull on a kit brand, npm release (runner on home is pinned to ^0.16.0 from npm).
- [ ] **Sync CLAUDE.md + .claude/rules with the brand** (owner, 2026-10-13) · user part of CLAUDE.md (outside the ef block) + `.claude/rules/**`; rides along with `ef push`/`ef pull`, `ef claude sync|pull|push` on demand; `ef init` restores missing files, keeps differing local ones and warns. Conflicts: base_hash → 409 → 3-way merge (`threeWayMerge`), markers + exit 4. Backend endpoint in ~/Work/elasticfunnels (TASKS.md there). Built: CLI tests 8/8 (fake server with the backend's 409 semantics; full suite 346/346), backend ab4dd371a + fea39a4c1 (13/13). Shipped dormant in CLI 0.20.0 (2026-10-13; live API answers 404 on /agent-files, so pull/push skip it silently). Left: deploy backend + migrate, then one live round trip (push on one folder, `ef init` in a fresh one).

## Done
