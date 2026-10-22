---
name: kit-customize
description: >-
  Rewrite an applied ElasticFunnels template kit for the customer's own product
  from their brief, facts and images, pages unpublished. Use for "customise the
  kit", kit_customize jobs, or when .ef/context/kit.json exists.
---

# Customise a kit for the customer's product

The kit was applied: its pages, products, funnels and assets exist in this brand, still about the
kit's demo product. Your job is to make them about the customer's product, using what the customer
gave you, and to leave them unpublished.

## Where you are

- **With the `ef` CLI (Claude Code, a terminal):** run the commands as written below.
- **In the ElasticFunnels runner (no shell):** the runner has already pulled the context into
  `.ef/context/`, synced the Drive folder and converted brief documents before your first turn.
  Read the files there. Use the page tools instead of shell commands:
  `kit_context_missing` for `ef context missing`, `generate_kit_image` for `ef images generate`,
  and `flag_kit_assets` for `ef context flag`.
  Your edits are saved as drafts when the turn ends.

## 1. Read the context

`ef context pull` writes `.ef/context/`:

| File | What it holds |
| --- | --- |
| `kit.json` | kit key and name, the apply run, its pages (slug + role), the product map (kit code -> new code, name) |
| `brief.md` | the customer's brief, then the text of each brief file they uploaded |
| `facts.json` | offer facts: product names, prices, guarantee, ingredients, audience |
| `assets.json` + `assets/` | the customer's images (product, role) and brief files, downloaded |
| `slots.json` | the kit's image slots: prompt, aspect, status, which pages use each one |
| `missing.json` | what is still missing; `blocking: true` rows stop the rewrite |

Read `brief.md`, `facts.json` and `kit.json` in full before editing anything. PDFs in `assets/` are
part of the brief: read them too.

**Stop only for a blocking row.** If `missing.json` has a row with `blocking: true` (an incomplete
Drive sync, or an open `asset_check` row), do not rewrite pages in this turn: tell the owner what is
blocked and how to fix it, then end the turn. An `asset_check` row is a check you or an earlier run
flagged; the owner answers it on the kit screen by confirming the files or replacing them. Every
other missing item (a fact, a product image, a slot without an image) does not stop you; you report
it at the end.

## 2. Check the brief and assets are for this product

The system prompt names the brand and its products, and `kit.json` has the product map. Before you
rewrite anything, check that what the customer gave you is about THIS brand's product:

- Look at every image in `assets/` (packshots and labels most of all) and read the product name on
  it. Read the product name the brief is about.
- If an image or a brief file shows another product or another brand, or the brief is about another
  product, flag it: `ef context flag --kind asset_mismatch --message "..." --asset 12,13 [--file 4]`
  (runner: `flag_kit_assets`). Use `--kind brief_mismatch` when the brief is the problem and
  `--kind other` for anything else. The message is one sentence for the owner that names what you
  saw and what you expected, for example "The Drive image shows Brain Memory Keeper bottles, but this
  brand sells Inflamora." Put the asset and file ids from `assets.json` on the flag.
- After flagging, stop: do not rewrite any page in this turn. Tell the owner what you flagged and
  that they can confirm the files or replace them on the kit screen.
- A Drive link to a single file (not a folder) is an error to report, not something to work around.
  Ask the owner for the link to the folder, shared as Anyone with the link can view.
- A check the owner confirmed (`ef context checks` shows it as `confirmed`) means the owner says the
  files are right. Do not flag them again: go on.

## 3. Drive and assets

- If `kit.json` has a `drive_url` and `drive_synced_at` is empty, run `ef assets sync-drive` (the
  runner already did). Exit code 2 means incomplete: report what did not come down.
- New files from the customer go in with `ef assets add <file> --product <CODE> --role packshot`
  (roles: packshot, label, logo, lifestyle, reference, testimonial, certificate).
- When you cannot tell which product an image shows, say so in the summary instead of guessing.

## 4. The customer's copy is used as given

The customer is responsible for their own claims. Use their brief and copy as written:

- Headlines, claims, testimonials, numbers, prices and guarantee terms from the brief or
  `facts.json` go in **verbatim**. Do not soften them, remove them, fact-check them or add
  disclaimers to them.
- Where the brief has no copy for a section, write it yourself from the brief, the facts and the
  kit's own section. Keep the kit's job for that section (hook, proof, offer, guarantee, FAQ).
- Copy you write yourself follows these rules: no em dashes and no " - " used as a dash; none of
  "powerful, seamless, unlock, elevate, game-changing, look no further, say goodbye to"; at most one
  "X, not Y" sentence per page; vary sentence and paragraph length; do not give every section the
  same skeleton.
- Write in the language of the brief.
- Match the customer's real offer from `facts.json`: their packs, prices, upsell and downsell
  prices. Where the kit has a section the customer has no material for (subscriptions, bonuses,
  testimonials), drop the section instead of inventing its content.

## 5. Products

The kit apply already created the products with the customer's codes (`kit.json` products: the
kit's `old_code` -> the new `code`). Rename and price them from `facts.json`:
`ef products update <id> --title "..." --price 49 --checkout-title "..."` (the product's `id` is in
`kit.json`). Never change a product code: pages, funnels and checkouts point at it. The runner has
no product tool: there, list the title and price each product needs in the summary.

## 6. Pages and shared components

For each page in `kit.json` (pull it first: `ef pull pages/<slug>.ef`):

- Keep the kit's structure, sections, directives, components, `[BUY=...]` links, product items and
  page events. Change the words and images, not the machinery.
- Swap every mention of the kit's demo product (name, price, guarantee, ingredients, testimonials,
  images) for the customer's.
- Images: use the customer's assets first (`assets.json`, matched by product and role). For a slot
  in `slots.json` that has no customer image and no generated `url`, generate one:
  `ef images generate --slot <slot> [--product <CODE>] --yes --max-credits <what is left>`
  (runner: `generate_kit_image`). Each image costs credits; the job has a credit cap. Stop
  generating when the cap is near and list the remaining slots as missing.
- Run `ef lint` (runner: `lint_ef`) after each page and fix what it reports.
- The kit's demo text also lives in shared components, not only in pages: the header, footer,
  theme, guarantee seals, package cards, the sign-in box, the upsell top bar. Rewrite the components
  under `components/` the kit pages use (`ef pull components/<name>.ef`, push with `--draft`).
- One funnel only should claim the landing pages. If two funnels point at the same landing page,
  say so in the summary.
- When every page is done, search pages AND components for the kit's demo product names (the
  `old_code` products in `kit.json` and their names) and fix what is left.

## 7. Pages stay unpublished

`ef push` **publishes** by default: the page goes live. Here the owner publishes, never you.

- Push with `ef push <file> --draft` (or set `ef config set saveMode draft` first).
- Never run `ef pages publish`, never push with `--direct`, never set a page online.
- The runner saves your edits as drafts on its own.

## 8. Finish

End every run with:

1. `ef context missing` (runner: `kit_context_missing`) and its list, blocking rows first.
2. A short summary per page: which sections you rewrote, which customer copy you used verbatim,
   which images you used or generated, and anything you were unsure about.
3. For the owner to decide, never deleted by you: the kit's demo products (archive candidates),
   and any kit funnel or kit page for a product the customer does not sell.
4. One line telling the owner that the pages are drafts and need their review and publish.
