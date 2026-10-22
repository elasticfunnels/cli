---
name: ef-page-check
description: Look at an ElasticFunnels page the way a visitor sees it (draft or live, desktop and mobile) with `ef shot` or Claude in Chrome, and check it before saying it is done. Use after editing or pushing a page, or for "screenshot", "preview", "how does it look".
---

# Check a page visually

Code that pushes without errors can still render broken: an empty section, an
unclosed tag that swallows the footer, a button off screen on mobile. After you
change a page, look at it before you report it done.

## 1. Pick the tool

1. **`ef shot`** (default). Run `ef shot --check` once per session.
   - `ready`: use it.
   - not ready: run `ef shot --install` (installs playwright-core into
     `~/.ef-cli/shot` and Playwright's headless Chromium, no sudo). If the
     install is not allowed or fails, go to 2.
2. **Claude in Chrome**, when the `mcp__claude-in-chrome__*` tools are there.
   Use it when you need to click, fill a form, read the console, or follow a
   flow across pages (checkout, quiz, upsell). Get the URL with
   `ef preview <slug> --json` (`previewUrl` = draft, `liveUrl` = published),
   open it in a new tab, and take screenshots there.
3. Neither: say so in your report ("not checked visually"), and give the
   preview URL so the owner can open it. Never say a page looks right when you
   have not seen it.

## 2. Shoot

```bash
ef shot <slug>                         # current draft, desktop 1440x900, full page in 1500px pieces
ef shot <slug> --size both             # desktop + mobile (390x844)
ef shot <slug> --live                  # the published page
ef shot <slug> --selector "#pricing"   # one section
ef shot <slug> --viewport              # first screen only (above the fold)
ef shot <slug> --chunk 0               # one tall image instead of pieces
ef shot <slug> --size 1280x720,mobile --json   # file list as JSON
ef shot https://example.com/page       # any URL
```

Images go to `.ef/shots/` (or `--out <dir>`), named `<slug>-draft-<size>-<n>.png`;
open each file with your image reader. Long pages come in pieces (1500 px,
1300 px on phones) so each one stays readable; old pieces of the same page and
size are removed first. Use `--selector` to look at just the part you changed.

Read the summary lines too. `ef shot` warns when a page scrolls sideways on
that screen ("the page is 520px wide on a 390px screen") and names what sticks
out, and when a phone shot has no `<meta name="viewport">`. Both are mobile
bugs to fix even if the images look fine. `--json` has them under `pages[]`
(`overflowX`, `overflowing`, `noViewportMeta`).

Draft vs live: `ef push --draft` changes only the draft, so shoot without
`--live`. After `ef push` (direct) or `ef pages publish`, shoot `--live` too:
that is the page buyers get, with the live domain's scripts and caching.

## 3. Check

Look at every image for:

- the part you changed: is it there, in the right place, with the right copy?
- empty or collapsed sections, broken images, raw `{{ }}` or `[[ ]]` tags,
  template placeholder text
- leftover placeholders: `[4]`, `[NAME]`, `XX`, lorem ipsum
- mobile: text overflowing the screen, buttons cut off, images wider than the
  viewport, tap targets too small
- the page ending where it should (a missing footer often means an unclosed tag)
- prices, product names and the buy buttons

Fix what you find, push, shoot again. Report what you looked at (sizes, draft
or live) and attach or name the image files.

## Exit codes

`0` ok · `1` tools missing (`--check`) · `2` bad option · `7` page, URL or
selector not found · `5`/`6` network or server.
