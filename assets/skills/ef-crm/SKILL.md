---
name: ef-crm
description: >-
  Build an ElasticFunnels CRM with `ef crm` (objects, fields, pipelines, entries), import a contact list from
  CSV/XLSX, and email it. Use for "set up a CRM", "import my contacts", "upload this list", "email my leads".
---

# CRM, contact import and sending to it with `ef crm`

A CRM object (an "entity", e.g. Leads) holds entries. Each entry has a title and `values`, keyed by the
object's custom fields. An object in `crm` mode can have pipelines with stages (a board); one in `data` mode
is a plain table. Entity arguments take an id or a slug.

## Hard rules for an agent

- Import only a file the user gave you or pointed you to. Never build a contact list yourself.
- Always run the import with `--preview` first and show the user the plan (rows, columns, the fields it will
  create). Run it for real with `--yes` only after they agree.
- Import is not idempotent: running it twice adds every row twice. If a run stopped, resume with the
  `--offset` it printed, never by starting again from 0.
- Keep contact data out of chat and files unless the user asked for it. Show counts and the plan, not rows.
- Sending to the list is a campaign: follow the `ef-campaigns` skill (test first, the user's go before
  `launch`/`schedule`).

## 1. Create the object

```bash
ef crm entities                                        # what exists already
ef crm entities create --name Leads --slug leads --entity-mode crm
ef crm pipelines create leads --name Sales --slug sales    # optional, crm mode only
ef crm stages create <pipelineId> --name New --slug new --order 1
```

You don't need to create fields by hand before an import: the import suggests a field per column and creates
the new ones. To add one yourself: `ef crm fields create leads --label Budget --key budget --type number`.

## 2. Import the contacts

```bash
ef crm import leads --file contacts.csv --preview      # plan only, writes nothing
ef crm import leads --file contacts.csv --yes          # create the new fields, then import the rows
```

- Files: `.csv`, `.tsv`, `.txt` or `.xlsx` (first sheet). Headers in the first row. 20 MB and 20,000 rows
  at most per file; split bigger lists. Old `.xls` and Numbers files must be saved as `.xlsx` or `.csv`.
- The plan shows each column's action: `existing` (matches a field already on the object), `create` (a new
  field with the suggested type: text, textarea, email, phone, url, number, date, datetime, boolean, select)
  or `skip` (an empty column).
- Change the plan: `--map "E-mail Address=email"` (a column, by header or 0-based index, to a field key; a new
  key is created with the suggested type), `--skip Notes` (repeatable), `--title "Full name"` (the column
  used as each entry's title).
- Objects with pipelines: entries go to the default pipeline's first stage unless you pass `--pipeline` and
  `--stage`.
- Rows go up in batches of up to 250 (`--batch`). The summary gives imported, skipped and failed counts and
  the failing rows' line numbers (the header is line 1). `--json` prints the whole result.
- The parsed file stays on the server for a day. Imported rows don't fire stage automations or form webhooks.

## 3. Send to the list

```bash
ef crm entities --json                                  # the object's numeric id
ef campaigns email create --name "Welcome" --subject "..." --from-name "..." --from-email hi@yourdomain.com \
  --crm-entity <entityId> --html-file welcome.html
ef campaigns email count <campaignId>                   # who it reaches after suppressions and consent
ef campaigns email test <campaignId>                    # one test to the user's own address
```

- The address comes from the object's field of type `email` (or a field keyed `email`). Check the plan shows
  the email column as type `email`; if it doesn't, `--map "Email=email"`. Entries without an address are
  left out. First and last names come from `first_name` / `name` / `full_name` and `last_name`.
- Suppressed addresses (bounces, complaints, unsubscribes) and recorded opt-outs are always excluded. Having
  no consent record counts as opted in, so remind the user to import only people who agreed to hear from
  them.
- To send to part of the list, or to people who also bought, build a saved audience instead (`ef-segql`
  skill) and use `--audience <id>`.
