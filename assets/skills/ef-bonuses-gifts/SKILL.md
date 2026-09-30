---
name: ef-bonuses-gifts
description: >-
  Set up ElasticFunnels per-product BONUSES (free products a buyer gets or
  picks with a package), pick limits per package, and GIFT orders ("send to a
  friend") with the `ef` CLI and checkout templates. Use when a task says
  "free bonus", "free gift with purchase", "pick 2 free bonuses", "choose your
  bonus", "treats", "bonus bundle", "send to a friend", "ship the gift to
  someone else", "gift shipping", a package that includes different free items
  than another package, or when editing checkout_settings.bonuses, the
  set_checkout_bonuses funnel node, [data-bonus-code] / [data-gift-toggle]
  markup, or `ef products bonuses` / `ef products bonus-rule`. Also use when you
  find a checkout that fakes free items as $0 order bumps, or stores a gift
  address in the CRM — that is the old hack this feature replaces.
---

# Bonuses, pick limits and gift orders

## The model (read this first)

- A **bonus** is a FREE product attached to a main product (a package). Bonus
  products have classification `bonus`. **Bonuses are not bumps**: bumps are
  paid, opt-in add-ons. A code must never be both.
- A **rule** per main product says how many bonuses the buyer gets:
  exactly N (`--pick N`), up to N (`--up-to N`), or all (`--all`). Each package
  is its own main product, so each package has its own rule.
- **Nothing picked ⇒ default fill**: the first N by position (`--default
  first_n`) or all (`--default all`). Position = the order of the bonus list.
- **The server is authoritative.** A pick that is not offered, over the max, a
  duplicate, or fewer than the minimum is **rejected with a 422**. It is never
  silently fixed. The client-side picker is only for instant UI.
- **Gift ("send to a friend")**: bonuses flagged **giftable** can ship to a
  friend's address. That creates a **separate linked order**: `type: 'gift'`,
  its own order id, `parent_conversion_code` = the main order's code, total 0.
  Non-giftable picks stay in the buyer's box. The gift toggle only appears when
  at least one selected bonus is giftable.
  - The friend's **email is OPTIONAL**. Collect it when the buyer has it, label
    the field "(optional)", never make it required. The recipient is **never
    notified** — no email goes to them.
  - Gift shipping price, charged on the **main** order: `same_as_main`
    (default: the gift costs what the main shipping costs, after coupons; main
    free ⇒ gift free), `free`, or `fixed` (+ price).
- **Activation**: the internal checkout only uses a product's bonuses when the
  product has a rule, or a page/funnel override exists. Attaching bonuses alone
  changes nothing on the internal checkout.

### Edge rules

- Bonuses are per order **line**, not per unit: qty 2 of a package = one set.
- Upsells/downsells (one-click, no picker): default fill, ship with the buyer, no gift.
- External networks (Digistore24, BuyGoods, Shopify) and manual orders: default
  fill when a rule exists, never over the max, never a gift (they cannot collect one).
- Subscriptions: bonuses on the initial order only; rebills never add bonuses or gifts.
- Out of stock: the bonus is removed from the options and min/max clamp to what
  is left; none left ⇒ no bonuses and no gift. A pick that sold out between
  render and pay is a 422 and the page re-renders.
- A checkout template **without** the bonus picker still ships the default fill
  (server-side), but offers no gift.
- A free-shipping coupon makes a `same_as_main` gift free too.
- Shipping insurance (`shi` bump) covers the main package only, not the gift.
- Gift countries: the ones the bonus products' shipping profile serves.
  `gift_message` ≤ 300 characters, names ≤ 100.

## Where the configuration lives — pick ONE per offer

Resolution order at checkout, first hit wins, per main product code:

1. funnel node `set_checkout_bonuses` (the path through a funnel)
2. `checkout_settings.bonuses` in the checkout page's backend script
3. `page.config.bonuses` (set in the page builder)
4. the product's rule + its bonus list (`ef products bonus-rule` / `bonuses`)

Use the **product rule** when the package ALWAYS comes with these bonuses. Use
an **override** (1–3) when the same main product must NOT carry bonuses on its
normal checkout, e.g. a seasonal offer. Override shape:

```js
{
  "<MAIN_CODE>": {
    options: ["CODE", { code: "CODE", giftable: true, quantity: 1 }],  // [] turns bonuses off
    min: 1, max: 1,              // max: null = all
    default: "first_n",          // or "all"
    gift_shipping: { enabled: true, mode: "same_as_main" }             // | "free" | { mode: "fixed", price: 4.99 }
  }
}
```

`ef lint` checks this shape in backend scripts: main-code keys, one code per
option, duplicates, `max` larger than the options, `min > max`, unknown
`default`/`mode`, `fixed` without a price, and a code that is also in
`checkout_settings.bumps`.

## CLI

```
ef products bonuses <idOrCode>                              # show list + rule
ef products bonuses <p> --add CODE[:qty][:giftable] …       # attach / update in place
ef products bonuses <p> --remove CODE · --order A,B,C · --giftable CODE · --not-giftable CODE · --clear
ef products bonus-rule <p> --pick <n> | --up-to <n> | --all
                           [--default first_n|all] [--min <n>]
                           [--gift on|off] [--gift-shipping same_as_main|free|fixed] [--gift-price X]
ef products bonus-rule <p> --clear                          # delete the rule
ef products list                                            # "bonuses" column: 3 (pick 1) +gift
ef products get <p>                                         # JSON with bonuses + bonus_rule
```

The CLI refuses a pick larger than the number of bonuses and `fixed` without a
price before calling the server. `--json` on every command. For a desktop app
without a shell, the MCP tool `ef_set_product_bonuses` does the same.

## Checkout template contract

Checkout templates are custom, so this is the whole interface.

Scope (`window.efScope.checkout`, also `{{ }}` / `[[ ]]`):

| Key | Shape |
| --- | --- |
| `checkout.bonus_rule` | `{ min, max, mode: 'pick'\|'all', label, main_code }` |
| `checkout.bonus_options[]` | `{ code, name, image, retail_price, retail_price_raw, selected, locked }` |
| `checkout.bonus_selected` | `[codes]` · `checkout.bonus_can_add` bool |
| `checkout.bonus_value` | sum of the selected retail prices ("$149.97 value — FREE") |
| `checkout.gift_shipping` | `{ allowed, enabled, price, recipient: { first_name, …, message } }` |

JS API: `ef.checkout.bonuses.get() / select(code) / deselect(code) / toggle(code) / set([codes])`,
`ef.checkout.gift.enable() / disable() / set({ first_name, … })`. On a pick-1
rule `select` replaces; on up-to-N it refuses past the max (returns false and
fires `checkout:bonusRejected`).

Declarative hooks, no JS needed:
- `[data-bonus-code="CODE"]` — click toggles; the element gets `data-selected` / `data-locked`.
- `[data-gift-toggle]` — checkbox/radio that turns the gift on/off.
- inputs named `gift_first_name gift_last_name gift_email gift_phone gift_address gift_address2 gift_city gift_state gift_zip gift_country gift_message`
  (or `data-template-value="checkout.gift_shipping.recipient.first_name"`);
  errors land in `[data-checkout-error="gift_zip"]`.
- The offer page can pre-select with `?bonuses=CODE1,CODE2` on the checkout link;
  the runtime sanitizes it.

Events: DOM `checkout:bonusesChanged` `{selected, added, removed, rule}`,
`checkout:bonusRejected` `{code, reason: 'max_reached'|'not_offered'}`,
`checkout:giftShippingChanged` `{enabled}`; analytics `bonus-selected`,
`bonus-removed`, `gift-shipping-selected`. The order carries `bonus_codes[]`,
$0 lines with `is_bonus: true`, and `gift_conversion_code` when a gift was sent.

## Never

- Never fake bonuses as $0 order bumps (`checkout_settings.bumps`) hidden with
  CSS and ticked by a polling script.
- Never store a gift address in the CRM or a session. The gift order carries it.
- Never make the friend's email required, and never send them anything.
- Never re-implement the pick limits in the page's backend script; the rule does it.

---

## Worked example: Herpafend Halloween, the right way

The offer: three packages, three free "treats", and the buyer may send the
treats to a friend.

| Package (main code) | Treats |
| --- | --- |
| 2 bottles `HERPAFEND_MAIN_2B_P158` | pick 1 |
| 3 bottles `HERPAFEND_HWN_3B_P170` | pick any 2 |
| 6 bottles `HERPAFEND_MAIN_6B_P294` | all 3 |

Treats: `HALLOWEEN_TREAT_SNOOZE_MAX`, `HALLOWEEN_TREAT_BIOME_SHIELD_MAX`,
`HALLOWEEN_TREAT_MORINGA`, all giftable.

`HERPAFEND_MAIN_6B_P294` also sells on the normal checkout WITHOUT treats, so
the rules go on the offer (`checkout_settings.bonuses`), not on the products.

### 1. Make the treats real bonus products

Each needs a name, an image, classification `bonus`, type `physical` (they
ship) and its fulfillment integration (in the app).

```bash
ef products get HALLOWEEN_TREAT_SNOOZE_MAX            # check title, image, classification
ef products update <id> --classification bonus --type physical --title "Snooze Max" --image ./snooze.webp
# … same for BIOME_SHIELD_MAX and MORINGA
```

### 2. Put the rules on the Halloween checkout only

In `pages/secure-checkout.ef`, backend script — replace `HW_BUNDLES`, the
`halloween.codes` bumps and the CRM gift save with:

```js
var TREATS = [
  { code: "HALLOWEEN_TREAT_SNOOZE_MAX", giftable: true },
  { code: "HALLOWEEN_TREAT_BIOME_SHIELD_MAX", giftable: true },
  { code: "HALLOWEEN_TREAT_MORINGA", giftable: true }
];
var GIFT = { enabled: true, mode: "same_as_main" };
var isHalloween = String(request.query.offer || "").toLowerCase() === "halloween";

setVariable("checkout_settings", {
  collect_tax: false,
  bumps: ["shi"],                      // insurance only. Treats are NOT bumps.
  bonuses: isHalloween ? {
    HERPAFEND_MAIN_2B_P158: { options: TREATS, min: 1, max: 1, default: "first_n", gift_shipping: GIFT },
    HERPAFEND_HWN_3B_P170:  { options: TREATS, min: 2, max: 2, default: "first_n", gift_shipping: GIFT },
    HERPAFEND_MAIN_6B_P294: { options: TREATS, max: null, default: "all", gift_shipping: GIFT }
  } : {}
  // … abuse_protection etc. unchanged
});
```

The pick limits, default fill, 422s and the gift order are the runtime's job.
The script only says what is offered. (`ef lint` checks it; because `options`
is a variable here, it checks the codes when written inline.)

### 3. Template: picker + gift block

```html
<div class="treats">
  <template-foreach data-each="b in checkout.bonus_options">
    <button type="button" class="treat" :data-bonus-code="b.code">
      <img :src="b.image" alt=""> <span data-ef-text="b.name"></span> <s data-ef-text="b.retail_price"></s> FREE
    </button>
  </template-foreach>
  <p data-ef-text="checkout.bonus_rule.label"></p>
</div>

<template-if data-condition="checkout.gift_shipping.allowed">
  <label><input type="checkbox" data-gift-toggle> Send my treats to a friend</label>
  <div class="gift-fields">
    <input name="gift_first_name" placeholder="First name"> <input name="gift_last_name" placeholder="Last name">
    <input name="gift_email" type="email" placeholder="Their email (optional)">
    <input name="gift_address" placeholder="Address"> <input name="gift_address2" placeholder="Apt, suite (optional)">
    <input name="gift_city"> <input name="gift_state"> <input name="gift_zip"> <input name="gift_country">
    <textarea name="gift_message" maxlength="300" placeholder="Gift message (optional)"></textarea>
    <div data-checkout-error="gift_zip"></div>
  </div>
</template-if>
```

Style `[data-selected]` / `[data-locked]` for the chosen and locked (6-bottle)
states. Delete the old CSS that hid `HALLOWEEN_TREAT_` bumps, the polling
script that ticked them, the sessionStorage form restore, and the
`halloween-treat-gifts` CRM save.

### 4. Offer page links

`/halloween` links to the checkout with `?p=<package>&offer=halloween&bonuses=HALLOWEEN_TREAT_SNOOZE_MAX`
to pre-select what the buyer chose on the offer page. The checkout sanitizes it.

### 5. Push and verify

```bash
ef lint pages/secure-checkout.ef
ef push pages/secure-checkout.ef
ef preview secure-checkout
```

Test order with the gift on: the main order has the picked treats as $0 lines
(the giftable ones moved to the gift), plus the gift shipping on its total; a
second order of type `gift` with its own id links back to it; two fulfillment
orders go out (`<code>` and `<code>-G`). The buyer is emailed; the friend is not.

### When the product rule is the better choice

If the 3-bottle package ALWAYS came with "pick any 2 of 3", skip the override:

```bash
ef products bonuses HERPAFEND_HWN_3B_P170 \
  --add HALLOWEEN_TREAT_SNOOZE_MAX:giftable --add HALLOWEEN_TREAT_BIOME_SHIELD_MAX:giftable --add HALLOWEEN_TREAT_MORINGA:giftable
ef products bonus-rule HERPAFEND_HWN_3B_P170 --pick 2 --gift on
```
