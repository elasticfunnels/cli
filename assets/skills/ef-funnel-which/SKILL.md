---
name: ef-funnel-which
description: Find which ElasticFunnels funnel a URL runs and why with `ef funnels which <url>`. Use when a visitor landed on the wrong funnel, after changing country or affiliate overrides, or before sending traffic.
---

# Which funnel runs for a URL

`ef funnels which <url>` asks the live page runtime which funnel a visitor on that URL gets.
The app sends a real request to the URL with a resolve-and-report header, so the answer uses
the same code as production. It is read only and changes nothing.

## When to use it

- A visitor, an affiliate or the owner says they saw the wrong funnel, the wrong upsell or the
  wrong checkout.
- You just changed entry pages, a country override or an affiliate override and want proof it
  works. Saving a funnel can also change which of two matching overrides wins, so check again
  after any `ef funnels settings` change.
- Before launching traffic: test the exact link the ad or the affiliate will use, from each
  country you target.

## Running it

```bash
ef funnels which https://shop.example.com/offer
ef funnels which https://shop.example.com/offer --param aff=123 --country GB
ef funnels which "https://shop.example.com/offer?utm_source=fb&aff=123" --region CA --country US
ef funnels which https://shop.example.com/offer --json     # full payload, every funnel in the trace
```

- The host must be one of this brand's domains (`ef domains list`). A foreign host exits 2.
- Affiliate, query parameters, host and path are read from the URL. Use the parameter name
  the traffic really carries (the merchant's affiliate parameter, `utm_source`, and so on).
  `--param key=value` appends one; repeat it for more.
- Country and region come from the visitor's IP, so the URL cannot carry them. Pass
  `--country` (two letters) and `--region` to test a geo override. Without them the runtime
  sees no geo, and a country rule will not match.
- Exit 7 means no page is served at that path. Fix the slug before reading anything else.

## Reading the output

1. **This URL runs <title> code <CODE>**, or **No funnel would run**. The line under it says
   how it won: a trigger override matched, it is the domain default, or it is the domain
   default used as the final fallback.
2. **?f=** line, when present: the URL names a funnel code, and that wins outright. Remove it
   from the link to test the normal rules.
3. **Loads**: the domain and the page that renders. **From URL**: the affiliate and query the
   runtime read. If the affiliate you expected is missing here, the link is wrong, not the rule.
4. **Merchant** and **After a purchase**: which merchant charges, and the page each product
   leads to. A "no next step" line means buyers go straight to a thank-you page.
5. **Why**: the override that matched and its conditions. An affiliate list shows as one line
   ("Affiliate 123 is one of the 25 affiliate IDs in this override"). **Other funnels evaluated**
   groups the losers by reason:
   - *not one of their entry pages*: that funnel never competes on this page.
   - *no overrides*: it can only run as the domain default.
   - *already the domain default*: its overrides are never read.
   - *overrides did not match*: compare its conditions with the From URL line and your geo flags.

Long lists are cut at 8 names. Use `--json` to see every row (`trace[]`, with `funnel_code`,
`step`, `outcome`, `reason` and `conditions`).

## Fixing the rules

Precedence, first match wins: `?f=` in the URL, then the visitor's existing funnel session,
then entry pages filter the candidates, then the first non-default funnel whose overrides
match, then the domain default.

1. Open the funnel you expected: `ef funnels get <code>` shows its domains, entry pages and
   override count. `--json` prints the rules.
2. Change what is wrong:
   - Not attached to this domain: `ef funnels settings <code> --add-domain <id>`.
   - This page is not an entry page: `ef funnels settings <code> --entry-pages <slug,slug>`.
     Entry pages only filter. A non-default funnel also needs an override to ever win.
   - Override conditions (country, region, affiliate, query parameter) are edited in the app,
     in the funnel's Trigger overrides.
3. Run `ef funnels which` again with the same URL and flags, and confirm the new winner.

The tester sends no cookies, so it shows what a new visitor gets. Someone who already entered a
funnel on this domain can stay in it. Test their complaint in a private window as well.
