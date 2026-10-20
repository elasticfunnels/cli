---
name: kit-customize
description: >-
  Turn an applied ElasticFunnels template kit into the customer's own product:
  rewrite every kit page from the customer's brief and facts, swap the kit's
  demo product names, prices, guarantee and images for theirs, keep the kit's
  structure and directives, and leave every page unpublished for the owner to
  review. Use when a task says "customise the kit", "make the kit about my
  product", "rewrite the kit pages for <product>", "kit_customize", when
  .ef/context/kit.json exists and the pages still show the kit's demo product,
  or when a job was started from "Customise with AI" on the kit apply screen.
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
  `kit_context_missing` for `ef context missing`, and `generate_kit_image` for `ef images generate`.
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
Drive sync), do not rewrite pages in this turn: tell the owner what is blocked and how to fix it,
then end the turn. Every other missing item (a fact, a product image, a slot without an image) does
not stop you; you report it at the end.

## 2. Drive and assets

- If `kit.json` has a `drive_url` and `drive_synced_at` is empty, run `ef assets sync-drive` (the
  runner already did). Exit code 2 means incomplete: report what did not come down.
- New files from the customer go in with `ef assets add <file> --product <CODE> --role packshot`
  (roles: packshot, label, logo, lifestyle, reference, testimonial, certificate).
- When you cannot tell which product an image shows, say so in the summary instead of guessing.

## 3. The customer's copy is used as given

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

## 4. Products

The kit apply already created the products with the customer's codes (`kit.json` products: the
kit's `old_code` -> the new `code`). Rename and price them from `facts.json`:
`ef products update <id> --title "..." --price 49 --checkout-title "..."` (the product's `id` is in
`kit.json`). Never change a product code: pages, funnels and checkouts point at it. The runner has
no product tool: there, list the title and price each product needs in the summary.

## 5. Pages

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

## 6. Pages stay unpublished

`ef push` **publishes** by default: the page goes live. Here the owner publishes, never you.

- Push with `ef push <file> --draft` (or set `ef config set saveMode draft` first).
- Never run `ef pages publish`, never push with `--direct`, never set a page online.
- The runner saves your edits as drafts on its own.

## 7. Finish

End every run with:

1. `ef context missing` (runner: `kit_context_missing`) and its list, blocking rows first.
2. A short summary per page: which sections you rewrote, which customer copy you used verbatim,
   which images you used or generated, and anything you were unsure about.
3. One line telling the owner that the pages are drafts and need their review and publish.
