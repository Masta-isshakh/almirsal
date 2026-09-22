# RODEO ERP — build status

A metadata-driven Odoo 19.4 clone on AWS Amplify Gen 2 + Next.js App Router,
built to the master spec. The whole point of the architecture (PART A) is that
276 screens are *rendered from metadata*, not hand-written, so the engine comes
first and the registry data feeds it afterwards.

## Spec coverage

The spec is now complete and lives in two places:

- **`ODOO_CLONE_MASTER_PROMPT_1.md`** (2.4 MB) — the full master prompt.
  The behaviour-defining prose parts are extracted verbatim into
  **`docs/spec/`** (A architecture, B design system, C shell & custom screens,
  D business logic, J build order) so a session loads ~170 KB, per J-3.
- **`registry/odoo_spec.json`** — the machine-readable capture of the live
  instance. Parts E/F/G/H/I of the master prompt are a rendering of this file
  and add nothing beyond it; the loader is the single consumer.

What the export holds:

| Item | Count |
|---|---|
| Apps | 22 |
| Menus (EN + AR) | 330 |
| Actions | 277 (236 act_window, 23 client, 10 server, 7 report, 1 url) |
| Views | 668 (161 list, 144 form, 163 search, 80 kanban, 37 pivot, 37 graph, 17 activity, 11 calendar, 8 gantt, 4 hierarchy, 3 cohort, 2 map, 1 grid) |
| Models | 201 |
| Fields | 3,980 captured + 52 synthesized |
| Field widgets | 169 distinct |
| Groups | 89 |
| Printable reports / financial reports | 29 / 19 |
| Seed models | 88 |
| EN → AR string pairs | 5,506 |

### Known limits of the export

- **Kanban card templates are summaries** (fields, widgets, texts, buttons,
  conditional hints), not QWeb layouts. Part E renders the same summary, so
  card layouts are composed per model from the summary plus Odoo's standard
  card structure and the C-8 descriptions.
- **Fields are view-driven.** A model's field list is what appears in some
  view, so comodels often lack their back-reference column. The loader
  synthesizes 52 one2many inverses (`<parent_table>_id`, flagged `inferred`)
  and uses `res_id` for polymorphic `mail.activity`-style models.
- **70 comodels are referenced but not captured** (`res.country`,
  `ir.attachment`, `product.product`, `crm.tag`, `utm.*`, …). Listed in
  `registry/generated/REPORT.md`; Part H does not cover them either, so their
  fields come from Odoo 19's definitions.
- **Action names are English-only**; menus carry the Arabic.
- Some one2many pairs share an inverse (e.g. journal inbound/outbound payment
  method lines) because the distinguishing domain was not captured.

## Done

### Toolchain
Upgraded from the Amplify starter (Next 14 / React 18 / DynamoDB Todo) to the
stack A-1 mandates: Next 15, React 19, TypeScript strict, Vitest, Sass,
Bootstrap 5.3. `@aws-amplify/ui-react` was dropped — it peer-conflicts with
React 19 and its Authenticator would be replaced by the custom login page
anyway.

### `packages/engine/expr` — the expression evaluator (A-2)
Odoo view attributes (`invisible`, `readonly`, `required`, `column_invisible`,
`decoration-*`, `domain`, `context`) are Python expressions. This is a
tokenizer, parser and evaluator for that subset:

- literals, tuples/lists/dicts/sets, adjacent-string concatenation
- `and`/`or`/`not` returning the *operand* (not a boolean), as Python does
- comparisons including chaining (`0 < qty <= 10`), `in`/`not in`, `is`
- full precedence, right-associative `**` binding tighter than unary minus
- `%` doubling as printf formatting (`'%(year)s' % {...}`)
- attribute access, subscripts, calls with keyword arguments, ternaries
- Odoo globals: `context.get()`, `uid`, `active_id`, `allowed_company_ids`,
  `parent.<field>`, `today`, `now`, `ref()`
- `datetime` / `date` / `time` / `relativedelta` with dateutil's real
  semantics — absolute fields replace, relative fields add, day clamps to
  month length (`relativedelta(months=1, day=31)` on 30 Sep → 31 Oct;
  `months=5, day=31` → 28 Feb), plus `strftime` with the `%-d` no-pad forms

Two deliberate deviations from CPython, both to keep a bad view attribute from
breaking the whole client:

1. Ordering comparisons coerce mismatched operands instead of raising
   `TypeError` (`False < '2026-01-01'` is common in real Odoo archs, guarded
   by an `and` that we cannot rely on).
2. `evalCondition()` catches any evaluation error and falls back to a caller-
   supplied default, reporting through `onError`.

### `packages/engine/domain` — domains (A-3)
- `normalize.ts` — parses polish notation (`['|', (…), (…)]`) into a tree,
  including the implicit `&` between consecutive leaves, and back again.
- `match.ts` — client-side matching for kanban filters, onchange checks and
  post-edit regrouping. Relational operators that need other records
  (`child_of`, `any`, dotted paths) are delegated to injected resolvers rather
  than guessed at.
- `sql.ts` — compiles to parameterised PostgreSQL. Relational traversal uses
  `IN (subquery)`, never joins, because a join across a one2many duplicates
  rows and silently corrupts list counts and pivot aggregates. NULL handling
  follows Odoo rather than SQL: `('state','!=','draft')` matches NULL rows and
  `('field','=',False)` means "empty" per field type. Identifiers are
  validated, never interpolated.

### `packages/engine/format` — formatting (A-4.19)
`formatFloat`, `formatMonetary`, `formatPercentage`, `formatFloatTime`,
`humanNumber`, `formatDate`, `formatDateTime`, `formatRelativeDate`,
`formatDuration`, plus `floatRound`/`floatCompare`/`floatIsZero` on a currency
rounding step. Implements the two bilingual rules explicitly: amounts always
use Latin digits with the label after the number (`0.00 QR`) even in Arabic;
Arabic dates use Arabic-Indic digits.

### `packages/engine/registry` — types, typed archs and the export loader
- `types.ts` — the A-2 metadata types (`FieldDef`, `ModelDef`, `ViewDef`,
  `ActionDef`, `MenuDef`, groups, reports, financial reports, seed).
- `arch.ts` — typed archs per view type. A list renderer reads
  `arch.columns`, a form renderer walks a `FormNode` union (field, button,
  group, notebook/page, sheet, header, buttonbox, chatter, label, separator,
  widget, settings app/block/setting, create-control, element). Every
  unknown attribute is kept verbatim in `attrs`.
- `spec-loader.ts` — turns `odoo_spec.json` into the typed `Registry`:
  splits every `EN ⇔ AR` string, normalises condition attributes,
  collects `decoration-*`, unions the 21 models present in both
  `models`/`submodels`, infers or synthesizes one2many inverses, assigns
  many2many relation tables, builds the menu tree in home-menu order, and
  extracts the i18n catalogs.
- `scripts/generate-registry.ts` (`npm run generate:registry`) writes
  `registry/generated/*.json`, `messages/{en,ar}.json` and a coverage
  `REPORT.md`.

The loader test runs against the **real export**, not a fixture, and includes
the A-8 gate: every `invisible` / `readonly` / `required` / `domain` /
`context` / `options` / `decoration-*` / `filter_domain` string in all 668
views and 277 actions is parsed by the expression engine — 5,000+ expressions,
zero failures.

### `styles/tokens.css` + `styles/webclient.css`
Every PART B token as CSS custom properties, values literal (0.6667px borders,
40.67px rows, 16.1px empty-state body), the 12 kanban swatches, the D3
category20 chart palette, and the shell styles (navbar 46px, control panel,
list, kanban, form, chatter, dialogs, toasts) written with logical properties
so `[dir=rtl]` mirrors.

### `packages/engine/schema` — schema from the registry
`generateDdl` / `syncSchema`: Odoo-style `_auto_init`. One table per model
(transient ones included), relation tables for many2many (symmetric pairs
share one), indexes on every many2one, DEFERRABLE foreign keys, `active`
defaulting to true. Idempotent; the registry is the migration history. The
full 270+ table schema builds in PGlite in ~8 s.

### `packages/engine/db` — database adapters
One `Database` interface, three adapters: **PGlite** (in-process Postgres for
tests and `npm run dev`), **pg**, and the **Aurora Data API** (translates
`$n` placeholders, expands arrays, maps transactions to transaction ids).

### `packages/engine/orm` — the ORM (A-3)
`Environment` (per request: uid, context, lang, companies, groups,
transaction) and `Model` with Odoo semantics: `default_get` (company /
currency / `default_*` context / hooks), required-field validation with
bilingual messages, x2many commands (0–6) for one2many and many2many,
stored computes with cross-model dependency triggers (`order_line.
price_subtotal` → order totals, and the reverse on unlink), record rules
(global AND, group OR), multi-company filtering, `active_test`, ordering by
many2one display name, `read` with `[id, display_name]`, `web_read` /
`web_save` specifications, `name_search`, `copy` ("(copy)"), `toggle_active`,
`onchange`, `call_button`, and chatter primitives (creation message, tracking
values, thread cleanup). `ir.sequence` draws numbers under `FOR UPDATE` with
date ranges and Odoo's `%(year)s` interpolation; a rolled-back transaction
releases its number.

### `packages/engine/seed` — Part I loader
Two-pass load of all 88 seed models: explicit ids with deferred FKs, then
display-name references (`"QAR"`, `"400101 Sales Account"`) resolved by
name/code, x2many links, `name_ar` → `ir_translation`, name-only comodels
(paper formats, template categories) created on demand, identity sequences
reset. Idempotent. Only the nameless Knowledge template articles and one
unit stay unresolved.

### `packages/apps` — business modules (Part D)
- `base`: partners (commercial entity), products (variant creation and
  mirroring, `[CODE] Name`), taxes (defaults incl. a tax group).
- `base/users` (D-16, Settings › Users): a user creates its partner and
  mirrors name/email/phone, default "Role / User" groups, login uniqueness,
  `new_password` hashing, and a pluggable identity provider —
  `lib/server/cognito.ts` provisions the Cognito account on create
  (AdminCreateUser sends the invitation), "Send an Invitation Email" resends,
  archive/unarchive disables/enables sign-in.
- `base/activity` (Part G): `mail.activity` defaults from context and type
  delay, `res_name`, chatter note on Mark Done with feedback and chained next
  activity, `activity_state` / `activity_date_deadline` / `activity_user_id`
  kept on the document; done activities are archived and vanish from x2many
  reads (active_test).
- `account` (D-3 core): journals, accounts, moves with balancing tax and
  receivable/payable items, posting with `INV/2026/00001` / `RINV/…`
  sequences, draft/cancel, invoice lines restricted by display type.
- `sale/invoice`: the Create Invoice wizard (regular / down payment
  percentage / fixed) producing real `account.move` invoices, `qty_invoiced`
  from invoice lines, `action_view_invoice`.
- `sale` (D-2): numbering on save, partner-driven addresses and payment
  terms, product-driven lines (description, unit, price, taxes), sections
  and notes, subtotal/tax/total with currency rounding, `qty_to_invoice` and
  invoice status by invoice policy, confirm / send / cancel / set-to-quotation
  / lock / unlock / preview, onchange with partner sale warnings, tracking.

### AWS backend (`amplify/`) — see `docs/COST.md`
Cognito (invitation-only), S3, Aurora Serverless v2 at 0 ACU minimum with
auto-pause and the Data API (no VPC in the app tier, no NAT, no proxy), and
a managed policy for the Hosting compute role. The ORM runs in Next.js route
handlers on Amplify Hosting — no AppSync, no separate RPC Lambda.

### Web client (`app/`, `components/`, `lib/`)
- `/web/login` (B-10), `/odoo` home menu with the 22 redrawn app icons
  (C-2), `/odoo/<slug>[/id|/new]?view_type=` routing (C-4).
- Navbar with app sections and dropdowns, systray, user menu with
  language switch and logout (C-1); `<html dir="rtl">` + Bootstrap RTL for
  Arabic (B-9).
- Control panel: New, breadcrumb, search facets (default `search_default_*`,
  text search via `filter_domain`, Filters with date-period submenus /
  Group By / Favorites saved as `ir.filters` with default + shared flags —
  `components/webclient/search.ts`), list header buttons acting on the
  selected rows, pager, view switcher.
- List view: sticky sortable header, optional columns, decorations, badges,
  tags, avatars, priority stars, footer sums via `read_group`, folded group
  headers with counts and sums, sample-data empty state (B-8).
- Kanban view (from the card summaries), form view (status bar with header
  buttons and stage pipeline, smart buttons, groups, notebook, editable
  embedded lines with add line/section/note, product onchange and the
  Catalog dialog, save/discard with Alt+S / Alt+J, `call_button` → action
  runner, dialog mode for `target=new` actions with footer buttons), field
  widgets (char, text, number, boolean, toggle, favorite star, selection,
  radio, date, datetime, daterange, remaining days, many2one with
  autocomplete/quick-create, avatar and badges variants, many2many tags /
  checkboxes, `res_user_group_ids` access-rights matrix, priority, colour
  picker, progress bar, percent pie, copy-to-clipboard, url/email/phone
  links, image upload, code/domain editors), chatter (send message / log
  note, feed with tracking values, activities with Schedule / Mark Done /
  Done & Schedule Next / Edit / Cancel), systray Messages and Activities
  panels (Late / Today / Future per document model).
- Reporting views: **pivot** (row/column group-bys with sub-totals at every
  level, several measures, collapsible headers, flip axis, expand all,
  click-through to the records, CSV download — `components/views/PivotView`),
  **graph** (bar / stacked / line / pie in plain SVG, two group-bys, measure
  and order selectors, hover values, drill-down — `GraphView`), **calendar**
  (day / week / month / year, colour legend with filters, quick create,
  ←/→ and `t` keys — `CalendarView`), **activity** (records × activity types
  — `ActivityView`). `components/views/groups.ts` holds the shared
  group-label / measure helpers; `export.ts` the CSV / Excel downloads.
- List ⚙ **Actions** on a selection (Export with a field picker in CSV or
  Excel, Archive / Unarchive with an **Undo** toast, Duplicate, Delete) and
  "select all N matching records"; form ⚙ menu (Duplicate, Archive, Delete)
  and a **record pager** (prev / next over the list page you came from).
- **Command palette** (Ctrl+K, or the search icon): fuzzy jump to any menu,
  record search across the models that have menus in one round trip
  (`globalSearch`), commands (new record, home, language, theme, log out),
  `/` `@` `>` prefixes, recent picks.
- **Dark mode** (user menu › Theme: light / dark / system; applied before
  first paint) — `components/webclient/theme.tsx`, tokens in `tokens.css`.
- Field polish: localised date / datetime inputs with a picker button and
  lenient typing (`20/9`, `+3`), tax totals block, tax-mode pill, empty text
  reads as `''` in view expressions, `column_invisible` evaluated against
  the parent record, `<widget>` list cells skipped.
- **Client-side routing** (`lib/client/navigation.tsx`): after the first
  server-rendered page every `/odoo/…` move is a `pushState` — action
  descriptions (~230 KB for Sales) are fetched once per action and cached,
  records are read into a 20 s cache when the pointer rests on a row (and
  for the pager neighbours), so list → form takes ~130 ms and breadcrumb /
  browser back ~40 ms instead of a 385 KB page per click. A top progress
  bar and list / form skeletons cover the remaining waits; Alt+N, Alt+←/→,
  `?` shortcuts sheet.
- **RPC batching**: calls made in the same tick travel in one request
  (`{calls: [...]}`, run concurrently server-side) — one session lookup and
  one SSR compute instance instead of six when a form opens; reference reads
  (currencies, activity types, groups, reports, favorites) are cached on the
  client and, for static models, in server memory (5 min, cleared on write).
- **ORM reads**: plain many2one names come back as subqueries in the same
  SELECT, every x2many field of a read is one UNION ALL query, the record's
  own display name rides along, hook models declare `displayNameSql` /
  `displayNameFields` — a full quotation form is 5 queries / ~0.35 s over
  the Data API (was 25 queries / 1.2 s); `web_search_read` counts with a
  window function in the same query as the page. `RODEO_SQL_TRACE=1` logs
  every statement with its duration.
- **Settings engine** (C-6, `components/views/form/Settings.tsx` +
  `packages/apps/base/settings.ts`): the 13-app settings page with the app
  sidebar, live search, hash anchors, setting cards (toggle, label, help,
  documentation link, dependent fields); values persist in
  `ir.config_parameter` (`rodeo.settings.<field>`, company-backed fields on
  `res.company`), only changes are written, `getSetting()` serves other apps.
- **Printable reports** (`lib/server/reports.ts`, `app/report/[report]/[ids]`):
  quotation / order / pro-forma and invoice / credit note documents as A4
  HTML with print CSS — the browser's "Save as PDF" makes the PDF, Arabic
  shaping and RTL come for free. Form ⚙ › Print and list Actions › Print,
  `ir.actions.report` and `sale.action_report_saleorder`-style buttons all
  open it; Preview buttons open the same page.
- **Send by email** (`lib/server/mail.ts`, `components/webclient/Composer.tsx`):
  the Send buttons open a composer (recipients with addresses, subject, body,
  document inline); Amazon SES v2 sends when `RODEO_MAIL_FROM` is a verified
  sender, otherwise the email is logged in the chatter and the user told; the
  quotation moves to "Sent" / the invoice to `is_move_sent`.
- **Payments** (`packages/apps/account/payment.ts`): the Pay button opens
  the Register Payment wizard (journal, method, date, amount, memo);
  `account.payment` numbered `PBNK1/2026/00001` with a balanced bank ↔
  receivable entry, invoices get `amount_residual` / `payment_state`
  (partial → paid); posted entries cannot be deleted.
- Kanban: drag cards between columns (writes the group field, optimistic),
  quick-create in a column, fold columns; default form/list views are
  synthesized for the 70 models the export captured without views.
- `/api/rpc` dispatching the A-4 surface; local password sessions or Cognito.

Verified over HTTP on the seeded database: login → home menu → Sales →
create partner, product, quotation `S00001` with lines (1,000 + 200) →
confirm → `sale`, grouped list, Arabic RTL home menu.

Also verified: confirm → Create Invoice → `INV/2026/00001` posted with
balanced items; Settings › Users creates a user, provisions the Cognito
account (sandbox pool), archive disables it; activities update the order's
`activity_state` and Mark Done logs the note.

Browser scenario (headless Chrome, `playwright-core` installed ad hoc, not a
dependency): list selection → Actions → Export dialog, select-all, form
pager + ⚙ menu, Ctrl+K menus and records, dark mode, pivot drill-down,
graph pie/line, calendar week/year, activity view — all green, no RPC
errors, in English and Arabic.

Identity (latest): the product is branded **Almirsal** (title, login card,
company record renamed once by `brandCompany`, Cognito invitation and
reset emails). Settings › Users invites through `AdminCreateUser` (the pool's
invitation template carries the temporary password); "Send an Invitation
Email" to an already-confirmed account sets a new temporary password and
mails it through SES or, without a mail server, shows it to the
administrator. Users created directly in the Cognito console are
provisioned in the app on their first sign-in (`provisionUser` in
`lib/server/session.ts`; concurrent first requests share one in-flight
provisioning per email, and `ensureLoginUnique` keeps a unique index on
`lower(login)`). `/web/reset_password` runs Cognito's code flow; "Log out"
clears the Cognito token cookies too.

One invitation, one password: `amplify/backend.ts` merges
`allowAdminCreateUserOnly` into the generated `AdminCreateUserConfig`
instead of replacing it (the earlier replacement dropped the branded
`InviteMessageTemplate`, so the pool fell back to Cognito's default text).
Every re-invite ("Send an Invitation Email") regenerates the temporary
password and invalidates the previous one, so the button now asks for
confirmation, the form shows a sticky "invitation sent" toast right after
the user is created, the chatter logs it, and the notification after a
resend says the earlier password stopped working. A user must sign in with
the password from the **latest** email.

### Verification and gap closing (2026-09-22)

A full pass over the master prompt and the export, done as three rounds of
**UI crawl → backend verification → workflow scenarios**, fixing everything
found in between. The tooling is in the repo so it can be re-run:

- `scripts/verify-backend.mts [--db pglite|aurora] [--crud]` — loads the
  registry on a fresh database, checks every view field and expression,
  runs `searchRead` / `searchCount` / `defaultGet` / `nameSearch` /
  `readGroup` on every model, every search filter, field and group-by,
  every action domain, and (with `--crud`) create → read → write → copy →
  unlink per model, creating required relations on the fly.
- `scripts/verify-workflows.mts [--db …]` — 135 checks over the business
  flows: quote → order → invoice → partial + full payment, lifecycle and
  copy, vendor bill → payment, journal balance rules, chatter / activities
  / activity filters, settings round trip, users, search + favorites,
  concurrent numbering, access control, purchase RFQ → receipt → bill,
  approvals, smart buttons. Cleans up after itself.
- `scripts/dev/required-check.mts` — required fields no form can fill (the
  check that found the missing title block, below); `scripts/dev/cron-check.mts`,
  `dash-compute.mts`, `buttons.mts`, `view-check.mts`, `eval-check.mts`.
- A headless-Chrome crawl (playwright-core, ad hoc) visits every action ×
  view mode × record / new form in English and Arabic and records console
  errors, failed requests, error toasts and unrendered views.

Engine mechanisms added for the export's computed and related fields:

- `FieldDef.sqlExpr` — a non-stored field defined by a SQL template
  (`{alias}`, `{uid}`, `{model}`), readable, searchable, groupable and
  sortable without a column (activity deadlines, `message_is_follower`,
  `complete_name`, `is_expired`, KPI counters…); `FIELD_SQL` in
  `registry/sql-views.ts` holds the per-model overrides.
- `ModelDef.sqlView` — reporting models (`sale.report`,
  `account.invoice.report`, `purchase.report`, helpdesk / planning / fleet /
  skills analyses…) are SQL views created by `syncSchema`, read-only.
- Mixin fields (`message_ids`, followers, activities, ratings, attachments)
  and audit fields are added to every chatter model; related fields are
  rewritten to joins on search; relative date literals (`'-365d'`,
  `'today +1d'`), `display_name` search through the name SQL, many2many
  group-by, `copy=True` line duplication, `setMethodFallback` for smart
  buttons the modules do not implement explicitly.
- The loader now keeps the form title block (`{title: […]}` → `oe_title`):
  the export wraps `<div class="oe_title"><h1><field name="name"/></h1>`
  that way and it was being dropped, so 40+ forms (projects, helpdesk teams,
  vehicles, journals…) had no name field. Required + readonly fields
  (computed in Odoo) no longer block a create, required `sequence` integers
  default to 10, and the models Odoo fills in Python got defaults
  (employees: marital / timezone / distance unit / HR responsible plus the
  `hr.version` record; documents, service types, resume lines, supplier
  info, bank statement lines, companies).

Screens and modules added in this round:

- Generic views: **gantt**, **cohort**, **map** (OpenStreetMap embed),
  **grid** and **hierarchy** (`components/views/*View.tsx`).
- **Financial reports** (C-13): `packages/apps/account/reports.ts` computes
  the 19 `account.report` definitions (balance sheet, P&L, cash flow, aged
  receivable / payable, general ledger, trial balance, tax report, partner
  ledger, journal audit, …) with period / comparison / journal filters,
  fold / unfold, drill-down to journal items, print and CSV export
  (`components/clientactions/AccountReport.tsx`).
- **Discuss** (`lib/server/discuss.ts`, `components/clientactions/Discuss.tsx`):
  Inbox / Starred / History, channels and direct messages (create, join,
  leave, add people), thread grouped by day, star / mark read, composer,
  8-second polling; notification and call settings dialogs.
- **Dashboards** (C-8.3, `packages/apps/dashboards.ts`,
  `components/clientactions/Dashboards.tsx`): the seven seeded dashboards
  (Sales, Product, Rental, Accounting, Invoicing, Benchmark, Helpdesk)
  computed from live data for a month / quarter / year / custom period with
  the previous period as baseline — scorecards, line / bar / pie / stacked
  charts (inline SVG), tables, KPI tables and benchmark gauges.
- **Accounting dashboard** (journal cards with live numbers) and kanban card
  buttons / ⋮ menus; **server actions** (`lib/server/server-actions.ts`)
  for the export's `ir.actions.server` menus.
- **Attendances** (D-8): navbar systray check-in / check-out with today's
  and this week's hours (`AttendanceMenu`), and the public **kiosk** at
  `/kiosk/<key>` (badge scan with a keyboard-wedge scanner, manual
  identification with optional PIN, auto-return delay, company clock).
  Settings › Attendances shows the URL and can regenerate the key;
  "Try kiosk" / "Open Kiosk Url" open it.
- **Documents** (`components/clientactions/Documents.tsx`): folder tree
  (Company / My Drive / Recent / Trash), upload (payload stored as base64
  in `ir.attachment.datas`, served by `/api/attachment/<id>`), links, new
  folders, download, open, trash / restore, drag & drop.
- **Scheduled actions** (`lib/server/cron.ts`, `/api/cron`): digest
  emails, calendar email reminders, automatic check-out of attendances left
  open, overdue-invoice reminders (chatter note + `last_reminder`); each run
  is recorded in `ir_cron`. In production an EventBridge rule calls the
  route every 15 minutes through an API destination (set `RODEO_CRON_KEY`
  on the branch; `RODEO_APP_URL` for a custom domain) — no Lambda, no VPC.
- Part D methods for purchase (full RFQ → order → receipt → bill state
  machine), approvals, accounting extras (reversals, hash lock, assets,
  loans, lock dates, accrued entries, reconciliation), HR (employee ↔ user,
  badges, departures, overtime), project / to-do / helpdesk (numbering,
  assignment, SLA), calendar / appointments / planning, sign / surveys /
  fleet, partners (geolocation), settings buttons, digests, gamification,
  knowledge trash, activity plans; a generic smart-button resolver.

Defects the rounds caught and fixed, for the record: the dropped form
title block; required + readonly fields blocking creates; missing Python
defaults (employees, documents, supplier info, …); the Data API rejecting
the `"char"` column `pg_class.relkind` used by the view sync (cast to text);
and the Skills History menu opening a model the export has no views for
(now `hr.employee.skill.report`).

Results of the third round on the final code: unit tests 177/177,
`tsc --noEmit` and `next build` clean, backend verification 0 failures on
PGlite and on the Aurora sandbox (`--crud`), workflows 135/135, UI crawl
(EN + AR, every action × view × record / new form) 0 problems.

Not implemented (honest list): real-time WebRTC calls and screen sharing in
Discuss, the spreadsheet editor behind dashboards and documents, OCR /
digitisation, customer / vendor portals and the public survey, appointment
and sign pages, PDF layouts beyond the print stylesheet, SMS, and website
modules. Binary payloads live in the database until the S3 attachment
path (`amplify/storage`) is wired.

**177 tests pass; `tsc --noEmit` and `next build` are clean.**

## Next — J-1 build phases

J-1 fixes the order and the gate for each phase:

1. **Foundation** — Amplify backend skeleton (Cognito, Aurora Postgres, S3,
   functions), Next.js shell with EN/AR + RTL build, tokens, Bootstrap 5,
   icon fonts, login page (B-10). *Gate:* login works, language switch
   mirrors the layout, a tokens page shows every component.
2. **Engine core** — ORM (A-3) over the Drizzle schema generated from
   `registry.models`, menus/actions loader, router, control panel + search,
   list/form/kanban views, the field widgets, dialogs, chatter, activities,
   import/export, command palette, systray, home menu. *Gate:* the Sales app
   is usable end-to-end (product → customer → quotation → send → confirm →
   invoice wizard) with pixel-parity screenshots.
3. **Remaining generic views** + settings engine + PDF + SES + cron.
4. **Apps** in the order Settings → Discuss → Calendar → Appointments → To-do
   → Knowledge → Sales → Rental → Accounting → Purchase → Project → Planning →
   Helpdesk → Employees → Attendances → Fleet → Approvals → Sign → Surveys →
   Documents → Dashboards → Apps, each with Part D methods, Part I seed and
   Part F settings; gate = every S-screen e2e spec passes.
5. **Cross-app flows** integration tests (D).
6. **Polish** — empty states, shortcuts, PWA, performance, a11y, mobile.

Phases 1–3 are complete: every generic view (list, form, kanban, pivot,
graph, calendar, activity, gantt, cohort, map, grid, hierarchy), the
settings engine (C-6), printable reports, email (SES) and scheduled actions
(EventBridge → `/api/cron`). Phase 4 is done at the level of the export:
every app's menus, actions, views, Part D methods, seed and settings are in,
plus the custom screens (Discuss, financial reports, dashboards, documents,
attendance kiosk). What remains is listed under "Not implemented" above,
then phases 5 (cross-app integration tests beyond `verify-workflows`) and
6 (polish: PWA, performance, a11y, mobile).
