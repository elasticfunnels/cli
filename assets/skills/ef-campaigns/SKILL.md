---
name: ef-campaigns
description: >-
  Build, test, schedule and launch ElasticFunnels email and SMS campaigns with `ef campaigns`, within the
  consent, opt-out and quiet-hours rules. Use for "send an email blast", "text our buyers", "schedule a
  campaign", "campaign stats".
---

# Email and SMS campaigns with `ef campaigns`

A campaign goes to an audience (a saved SegQL segment, see the `ef-segql` skill) or, for email, to all
customers, a manual list or a CRM collection. The server enforces consent, suppressions and quiet hours on
every send; the CLI cannot switch them off.

## Hard rules for an agent

- **Never launch or schedule without the user's explicit go for that campaign and that audience size.**
  `launch` and `schedule` print the audience count and stop unless `--yes` is passed. Show the user the
  count, the subject or text, and the time, then pass `--yes` only after they confirm.
- Tests are free to run: `test` sends one message to one address or phone and never touches the audience.
  Send tests only to an address or phone the user owns.
- Do not import or paste contact lists you were not given. Do not add people to an audience to get around
  a consent or suppression exclusion.
- Recipient lists and samples come back masked without the "view contact PII" permission. Keep them out of
  files and chat unless the user asked for them.

## Email workflow

```bash
ef audiences list                                     # pick or build the audience first
ef campaigns email create --name "Oct reorder" --subject "Time to restock?" \
  --from-name "Acme" --from-email hello@acme.com --audience 42
ef campaigns email set 17 --html-file email.html      # or --content blank|default|template --content-id N
ef campaigns email audience-preview 17                # who it would reach now, after exclusions
ef campaigns email test 17 --to me@acme.com           # required before launch
ef campaigns email schedule 17 --at 2026-11-03T15:00:00Z   # prints the count, needs --yes
ef campaigns email launch 17                          # send now, prints the count, needs --yes
ef campaigns email stats 17                           # sent, delivered, opens, clicks, bounces, unsubscribes
```

- Audiences: `--audience <segment id>`, `--all-customers`, `--emails a@x.com,b@y.com` or
  `--emails-file list.txt`, `--crm-entity <id>`. Live (real-time) segments cannot be used.
- `ef campaigns email get <id>` lists what blocks sending in `problems`: `no_audience`, `no_content`,
  `no_subject`, `no_from_email`, `no_marketing_address` (the brand's postal address for the footer, set in
  Settings), variant problems.
- Launch refuses until a test was sent (`--skip-test` overrides; only with the user's say-so), and a
  schedule must be more than a minute ahead. Test sends are limited to 10 an hour.
- `unschedule` puts a scheduled campaign back to draft; `cancel` stops one that is scheduled or sending.
  Only drafts can be edited.

**Who is left out of an email send:** addresses on the suppression list (bounced, complained,
unsubscribed, added by hand) always; people who said no at opt-in (an unticked box recorded as "no");
duplicates. A contact with no consent record counts as opted in. `audience-preview` shows each number.
Every campaign email carries an unsubscribe link and the brand's marketing address.

## SMS workflow

```bash
ef campaigns sms create --name "Flash sale" --body "Hi {first_name|there}, 20% off today: https://acme.com/sale" --audience 42
ef campaigns sms preview 9               # rendered text, characters, segments, encoding, warnings
ef campaigns sms audience-preview 9      # reachable phones and why others are skipped (counts only)
ef campaigns sms test 9 --phone +14155550123
ef campaigns sms schedule 9 --at 2026-11-03T17:00:00Z   # prints the count, needs --yes
ef campaigns sms launch 9                               # needs --yes
ef campaigns sms pause 9 | resume 9 | cancel 9 | unschedule 9
ef campaigns sms stats 9
```

- `--audience 1,2 --exclude 3` take segment ids; `--exclude-regions US-FL,US-OK` skips places.
- Text is up to 1600 characters. The opt-out footer ("Reply STOP to opt out" by default) is added to
  marketing texts; a custom `--footer` must contain STOP. Keep `--opt-out yes`.
- The SMS test goes through the real provider and the same compliance checks, so it costs a message.

**SMS compliance the server applies, in order:** feature on, valid number, allowed country, not
suppressed (STOP, HELP and START keywords are handled automatically), the brand has accepted the consent
attestation (until then marketing texts are skipped as `no_attestation`), consent, state rules, excluded
regions, a ready sender, content checks, frequency cap, quiet hours.

- **Quiet hours:** texts go out 8am to 8pm in the recipient's local time (Pennsylvania 9am to 7pm and not
  on Sundays or federal holidays; Connecticut 9am to 8pm). A brand window can only narrow this. When the
  place is unknown, the send must fit every mainland US time zone. Texts outside the window wait for it;
  launching late in the day spreads the send into the next morning.
- **Frequency cap:** 3 marketing texts per phone per 24 hours by default (the Florida, Oklahoma, Maryland
  and Oregon rule), optionally a weekly cap.
- **Consent:** contacts carry a consent level (marketing, written consent with wording for the states that
  need it, transactional, existing relationship, unconfirmed import). In the default warn mode, missing
  consent shows as a warning count in `audience-preview`; in strict mode those phones are skipped.
  Do not text people the user cannot show consent for, whatever the mode.

## Reading results

`stats` gives sent, delivered, failed and skipped-by-reason for SMS; sent, delivered, opened, clicked,
bounced, unsubscribed and complaints for email. `recipients <id>` lists each send and its status (masked
as above). Opens are an estimate (privacy proxies inflate them); judge a campaign on clicks and orders.
