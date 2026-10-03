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

Navbar follow-up (reported on the Accounting tabs): the shell's links used
`next/link`, so every menu click was a server navigation that remounted the
web client and re-derived the app from the action's *first* menu — opening
Accounting › Customers › Customers switched the navbar to Sales, and the
tabs looked broken. The web client now uses plain anchors handled by the
client router (`lib/client/navigation.tsx`), links carry the app they were
clicked in (`data-app`), and the shell keeps the current app while it can
reach the action (`useCurrentApp` in `WebClient.tsx`, remembered per tab);
section dropdowns switch on hover like Odoo's. Programmatic moves (records,
smart buttons, server-action results such as Appointments › Resources
opening the calendar) keep the current app too. Found by the same
click-through: a server action reached by URL renders its ad-hoc
`act_window` result in place under its own path with its own name, domain
and context (`components/webclient/ServerActionRunner.tsx` — Resource and
Staff Bookings, Certifications, the skills log…), Kiosk Mode opens in the
same tab (Odoo's `target: 'self'`), a server action that opens a new tab
shows an "Open" card instead of an endless spinner, `ir.actions.act_url`
menus (Discuss › Configuration › Settings) are followed by the client
router, and the one menu bound to an `ir.actions.report` (Sign › Reports ›
Green Savings) renders a page (`components/clientactions/GreenSavings.tsx`).
An `act_url` that points at another app's page (Discuss › Configuration ›
Settings → `/odoo/settings`) hands the app choice to that page, so the
navbar becomes Settings as in Odoo, while every other programmatic move
keeps the app you are in.

An app's own landing action now wins when an action is listed in several
apps (`menuForAction` in `lib/server/actions.ts`): Appointments, Employees
and Fleet also appear inside Calendar, Planning and Accounting, so opening
`/odoo/appointments` used to show Calendar's navbar.

The navbar dropdowns were rendered but invisible: `.o_menu_sections` carried
`overflow: hidden`, which clipped each open section to the 33px navbar strip.
Every automated check passed, because a clipped menu still has a box and
still answers "visible". The sections no longer clip, the navbar sits above
the content, and — as in Odoo — the sections that do not fit the width move
into a "more" (⋯) menu, measured once and recomputed on resize
(`MenuSections` in `Navbar.tsx`). Both checks now ask the browser what is
painted at a menu's own centre instead of trusting the DOM:
`scripts/dev/overlay-check.js` does it for every dropdown on nine screens
(88 overlays, EN + AR), and `nav-check.js` for each open section.

Arabic coverage: the export ships part of the interface untranslated (Odoo's
own Arabic pack does not cover it), so switching to Arabic left menus, field
labels, settings text and whole screens in English — "Depreciation Models"
in Accounting › Configuration, and the accounting dashboard almost entirely.
`messages/ar.json` is the catalog `useT()` falls back to when an export
string has no Arabic, and it gained about 900 entries: 21 menus, 57 action
titles, 292 field labels, 272 in-view strings, 64 selection values and 128
strings our own screens pass to `t('…')`. Eleven models the export left
named after their table (`documents.document`) got real names in
`registry/extra-models.json`, and 57 catalog entries that the export had
mis-paired — "Access Groups" mapped to "Configuration Wizard" — were
translated or dropped. `scripts/dev/i18n-check.mts` walks the registry and
the source for strings with no Arabic (brands, IANA time zones, EU tax and
routing codes are listed as staying Latin), and `scripts/dev/ar-scan.js`
reads the running client in Arabic and reports any label still in Latin
script. Seeded record names (journal names, chart of accounts) are data from
an English export, not labels; the accounting dashboard renders journal
titles through the catalog, as Odoo's language pack does.

Screens behind the menus (2026-09-29): the menus opened their screens, but
"working" had never been tested — only that a view rendered. Three checks now
use the screens the way a person does, and the fixes came from what they
found.

- `scripts/dev/screen-check.js` opens every menu action and switches through
  each view in the switcher, applies the first search filter, groups the
  rows, presses New and opens a record — 236 screens.
- `scripts/dev/create-check.js` fills a new record's empty fields, saves it,
  checks it was written and deletes it again.
- `scripts/dev/button-check.js` presses each header button, smart button and
  cog entry on a saved record and reports any that do nothing at all.
- `scripts/dev/create-probe.mts` is the fast version of the same question at
  the data layer: can each model be created from a name, and when it refuses,
  is the field it asks for one the form actually shows?

What they found: a save that failed left the form silent — the error dialog
named the fields but nothing on the form pointed at them, so the record just
stayed dirty. The form now marks the refused fields, scrolls to the first and
clears the mark when you edit it, and required fields carry a marker
(`o_field_required`). Underneath, a dozen models could not be saved at all
from their own screen, because a required field with no default sat behind a
tab or was missing from the form: `packages/apps/base/form-defaults.ts` gives
those fields the defaults Odoo defines (journal reference type, fleet units,
activity delays, payment method code, mail server authentication…), the
loader adds a required field the export dropped back to the end of the sheet,
and model hooks make the records Odoo makes on the side (a project's mail
alias, an appointment resource's resource). Knowledge's article editor is a
custom widget in Odoo, so the export had no visible form for it and New
opened an empty page; `components/clientactions/Knowledge.tsx` is that screen
— the tree of workspace, shared and private articles with favourites and
trash, the title and body, new child articles, duplicate, trash and restore.

The button pass found the rest: 26 buttons the export declares had no
implementation (`scripts/dev/buttons.mts` counts them), so pressing them
answered with "Method … is not implemented" or with nothing at all.
`packages/apps/base/screen-buttons.ts` implements them — the helpdesk team
dashboard's ticket counters, a sale order's transactions, rentals, projects
and planning, a company's branches, a message's record, leaving a channel —
and where this build genuinely cannot do the thing (installing a module,
two-factor authentication, the spreadsheet editor) the button says so
instead of failing silently. `scripts/dev/sql-columns-check.mts` catches the
other silent kind: raw SQL naming a column the schema does not have, which
aborts the transaction and makes every later statement in the request fail
with a message that names nothing — one of those was why the lock-date
wizard could not be opened.

What the checks say now, on a production build over a seeded database: 236
screens open, switch views, filter, group, offer New and open a record with
no problem; 191 screens take a new record through New, Save and Delete (the
rest ask first for a record that does not exist yet on an empty database);
every button answers; 247 menu visits and 88 dropdowns behave. A button that
refuses on purpose ("add a question before sharing the survey") counts as
working — the check reads the error kind and only a crash fails it.

Running the checks: `scripts/dev/nav-check.js` needs a server that is not the
one under `next dev` in the same folder. Two Next processes in one project
share `.next/`, and the loser starts serving 404 chunks — the page then
renders but never hydrates, which looks exactly like "the menus do nothing".
Use a production build on another port, or mirror the project into a scratch
folder (copy the source folders, link `node_modules`, leave
`amplify_outputs.json` out so it runs on PGlite) and start `next dev` there. `scripts/dev/nav-check.js`
(playwright-core, ad hoc like the crawl) clicks through every app × every
menu item with client-side navigation and asserts the view rendered, the URL
changed, the dropdown closed and the app stayed — the page-load crawl cannot
see this class of defect.

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

### Accounting, Sales, Renting and Fleet against Odoo (2026-09-30)

A pass through the four apps the screens are used from most, asking of each
screen not "does it draw" but "does it do what Odoo's does", plus the fields
and buttons behind them. Two new checks came out of it:

- `scripts/dev/form-fidelity.js` reads the export's own form and list views as
  the specification and compares them with the screen: every field on the
  sheet, every tab, every default list column. A field the view hides behind a
  condition is not expected; everything else is. 176 forms and their lists are
  compared.
- `scripts/dev/search-check.js` presses every entry of the Filters and Group By
  menus of every screen and asserts the screen survived and the search
  actually changed. A filter whose domain names a column the registry does not
  have, or a group by the reader cannot group, answers with a server error and
  leaves an empty screen — nothing else in the suite sees that.

What they found, and what now exists:

- **Renting was a shell.** `is_rental`, `rental_status`, `has_pickable_lines`
  and `has_returnable_lines` were never written, so the Rental app's own list
  was empty whatever you created, the Scheduled Rentals gantt found nothing,
  and Pickup and Return said "nothing to pick up" on every order.
  `packages/apps/sale/rental.ts` is the app: a line with a rental period is a
  rental line and inherits the order's period, Pickup records the delivered
  quantity and Return the returned one, the order's rental status follows its
  lines (Reserved → Picked-up → Returned), and Update Rental Prices prices the
  lines from their products again.
- **Quotation templates did nothing.** Picking a template on a quotation left
  it empty. `packages/apps/sale/template.ts` copies the template's lines with
  their products, quantities, discounts and taxes, its sections, its terms,
  its validity and its signature and payment requirements — and leaves a
  quotation that already has lines alone. Optional template lines stay out:
  the export carries no model to keep a customer's options in.
- **The invoice had no payment panels.** Odoo draws the payments applied to an
  invoice and the outstanding credits that can be applied with one click;
  `PaymentsWidget` (the `payment` widget) draws both, and
  `js_assign_outstanding_line` / `js_remove_outstanding_partial` on
  `account.move` apply and take off a payment, with the invoice's residual and
  payment state following.
- **Fleet never warned about a contract.** `contract_renewal_due_soon`,
  `contract_renewal_overdue`, `service_activity` and `has_open_contract` are
  in the export with no compute, so the vehicle list showed no warning and the
  "contracts to renew" filter found nothing. They are SQL now, declared in
  `registry/extra-models.json` under `field_sql` (a section for fields the
  export declares but computes in Python).
- **Smart-button counters were always zero.** 41 `*_count` fields had nothing
  to fill them, and a smart button that hides on a zero count stayed hidden —
  fewer buttons than Odoo shows. `packages/engine/registry/counters.ts` reads
  each counter from the relation its button opens, as a SQL expression, so 22
  of them are now always current; the rest are left alone on purpose, because
  their name says they count a subset ("closed_subtask_count") or belong to a
  related record ("partner_bill_count") and a count of everything would put a
  wrong number on the screen. `packages/engine/registry/stems.ts` holds the
  naming knowledge the counters and the smart-button resolver share.
- **Widget routing was a chain nobody could audit.** `widgetKind`
  (`components/fields/routing.ts`) decides which control draws a widget, and
  `Field` and `scripts/dev/widget-check.mts` now ask the same function — so
  what the audit calls handled is what the screen draws. That turned a report
  of 116 "unhandled" widgets, most of them false, into a real list: the
  remaining 45 are single uses of features this build does not have (OCR
  extraction, the spreadsheet editor, partner autocomplete over IAP, the mail
  composer's internals) or names for a control that is already right. Along
  the way the aliases picked up what Odoo actually asks for: tags where the
  flavour name comes first (`helpdesk_sla_many2many_tags`), state badges
  (`state_selection`), favourite stars (`project_is_favorite`), hours as
  `float_time` (`timesheet_uom`), percentages, embedded lists for the o2m
  flavours, and the analytic distribution, activity exception, presence
  status and duplicate-document buttons as their own widgets.
- **Two hook kinds were silently dropped.** `registerModelHooks` merged
  `computes`, `tracked` and `defaults` but *replaced* `beforeCreate`,
  `beforeWrite`, `onCreate`, `onWrite` and `onUnlink`, so a second module
  registering one of those threw the first away — renting's line rule cost the
  sale app's own. They chain now, in registration order.
- The seed no longer writes a field the registry computes in SQL, and the
  calendar and Discuss code no longer updates counters that are computed.

- **Some menu entries showed a technical name.** About thirty filters and
  group-bys in Odoo's own search views carry no label (`<filter
  name="groupby_category" context="{'group_by': 'category'}"/>`), and the menu
  printed the name: "groupby_category", "myinvoices". `entryLabel`
  (`components/webclient/search.ts`) does what Odoo does — the label of the
  field the entry acts on, else the name read as words — and the facet that
  lands in the search box uses the same label, so both sides also translate.

- **Filters of one group were AND-ed.** Odoo reads the filters between two
  separators as one question: Customer Invoices switches on both "Invoices" and
  "Receipts" by default, which asks for either. Ours asked for both at once, so
  the list was empty on a database that had invoices — the facet now reads
  "Invoices or Receipts", as Odoo writes it, and the domains are OR-ed
  (`filterGroups` / `orDomains`, `tests/search-groups.test.ts`).
- **List rows had no `o_data_row` class.** Odoo names every list row that way;
  ours did not, so the checks that click a row to open a record silently skipped
  every list screen and pressed buttons on 14 screens instead of 57. The class
  is on the rows now (and on the rows of an embedded list), which is both
  Odoo's markup and what made the button pass real.

`scripts/dev/buttons.mts` also had to be taught that Odoo spells a method
button more than one way, and to read a view-level click action
(`<kanban action="…" type="object">`, how the Sales Teams board opens a team)
as the button it is — which found two unimplemented: all 435 buttons the export
declares now have an implementation.

`scripts/dev/populate.mts` came out of the same lesson: on an empty database a
check that needs a record skips the screen and reports nothing, which reads like
a pass. It puts a record in front of every screen (a required relation is filled
the way `verify-backend --crud` does) and then builds what the four apps show —
a quotation, a confirmed order, a posted invoice, a vendor bill, a rental order
out on rental, a vehicle with a contract, a service and an odometer reading.

What the checks say on the final code, on a production build over a database
`populate.mts` filled: 236 screens 0 problems (125 of them opening a real
record, where the earlier rounds could only reach 16), 1054 filter and group-by
presses on 170 screens 0 broken, 224 buttons pressed on 57 screens 0 dead, 176
forms missing nothing their view declares, 191 New-and-Save screens 0 failures,
247 menu visits in English and 247 in Arabic 0 problems, 88 dropdowns painted,
`verify-backend` 13 782 checks 0 failures, `verify-workflows` 153 checks 0
failures (renting and fleet among them), 194 unit tests, `tsc --noEmit` and
`next build` clean, 0 English strings without Arabic. Two runs each flagged one
item that passed on its own — a click that timed out at six seconds while the
rest of the suite was running; the fix for a slow machine is to run one check at
a time, not to trust a single red line.

Known differences from Odoo that remain, on purpose: the invoice `alerts`
banner (Odoo's actionable errors) is not computed — posting refuses with the
same message instead; rental prices come from the product, because the export
carries no `product.pricing` recurrences; a quotation template's optional lines
are dropped, because the export has no model to keep a customer's options in;
and 45 single-use widgets draw generically (`scripts/dev/widget-check.mts`
lists them) — OCR extraction, the spreadsheet editor, partner autocomplete over
IAP, the mail composer's internals.

### The public pages, the document layout and the last widgets (2026-09-30)

What "not implemented" still covered, closed in order of what a business needs
most. Every page here is reached by a link that carries its own token; none of
them creates, reads or touches a session, so nothing about signing in changed.

- **The customer portal** (`app/my/[kind]/[id]`): the page a customer opens from
  a quotation or an invoice — the document as it prints, what it is waiting for,
  Accept & Sign (the name they type is kept in `signed_by`/`signed_on` and the
  order is confirmed), Decline with a reason (the order is cancelled), Print, and
  the amount due on an invoice. Both answers land in the chatter. Odoo's Preview
  buttons now open this page instead of the print view, and
  `_portal_ensure_token` is `portalToken` in `packages/apps/common.ts`.
- **Signing from a link** (`app/sign/[item]`): every `sign.request.item` carries
  its own token, so a signer outside the company can read the documents and
  sign; the request's counters follow, and the last signature closes it. There
  is no mail gateway in this build, so sending a request puts each signer's link
  in the chatter for whoever sent it.
- **The public survey** (`app/survey/start/[token]`): the questions as a form —
  single and multiple choice, short and long text, numbers and scales, dates —
  answered into `survey.user_input` with one `survey.user_input.line` per
  question (a skipped question included), which is what the survey's own
  reporting reads. An invitation-only survey needs its answer token.
- **Appointment booking** (`app/appointment/[id]`): the free times of the next
  fortnight from the type's weekly slots, minus what is already booked, and a
  booking writes the `calendar.event` and the `appointment.booking.line` Odoo
  writes. A posted time that the page did not offer is refused.
- **The document layout reaches the paper.** "Configure Document Layout" saved
  the logo, the colours, the font, the tagline and the footer, and every report
  ignored them. They are on the company now (the wizard writes the fields the
  export dropped), and the report reads them: the logo, the two colours as CSS
  variables, the font, the tagline, the footer, the paper format (size, margins,
  landscape) and Odoo's four layouts — Light, Boxed, Bold, Striped. Html the
  company supplies is stripped of scripts and event handlers before it prints.
- **The invoice alerts banner** (Odoo's `actionable_errors`): a draft with no
  lines, without a partner, a bill without its date, an entry whose sides do not
  match, a reference another document of the same partner already uses. It is a
  SQL expression, so it is never stale, and it says nothing about a document that
  is ready.
- **Widgets**: 45 drawn generically became 4. The employee org chart, the grouped
  résumé and skills, the timezone mismatch warning, company identifiers (with the
  dialog that adds one), contact statistics, the rounding warning, file sizes as
  "1.2 MB", canned-response shortcuts as ":hello", and a date that will not go
  before the date another field holds. A list cell now hands a readonly widget to
  the field renderer, so a star, a badge or a size looks the same in a list as on
  a form. What is left needs a service this build does not have: Odoo's IAP
  partner autocomplete, OCR extraction and the spreadsheet editor.
- **Two silent bugs**, both from a backspace character standing where `` was
  meant in a regular expression: `column_invisible` on an embedded list kept its
  `parent.` prefix (so the condition could never resolve), and the portal's
  language sniffing never matched Arabic. A check for control characters in the
  source is part of the sweep now.
- **Record names**: 40 models had no `name` field and showed their id — a survey
  answer read "3" instead of "Well". The loader picks the field a record is
  actually named by (`value`, `title`, `reference`, `key`…), as Odoo's `_rec_name`
  does.
- Tokens come from the platform's cryptographic source rather than
  `Math.random()`, which also covers the kiosk key and meeting codes.

**Attachments can leave the database.** The bucket
`amplify/storage/resource.ts` defines was already deployed and nothing used it:
every payload sat base64 in `ir_attachment.datas`, which Aurora's Data API cannot
read back past a megabyte — a large attachment was not merely expensive, it was
unreadable. `packages/engine/orm/filestore.ts` is the seam (the apps know only
the interface), `packages/apps/base/attachments.ts` writes anything over 64 KB to
the store and keeps the key, the size and the sha1 on the row as Odoo does, and
`lib/server/files.ts` is the S3 store, read from the same `amplify_outputs.json`
the database details come from. Without a bucket — a PGlite dev box — payloads
stay in the row exactly as before, and the tests run against a store in memory,
so none of this needs AWS to be exercised. Two things are needed to turn it on:
`npm install` (the `@aws-sdk/client-s3` dependency is in `package.json`) and a
deploy, because the SSR compute role's new `grantReadWrite` on the bucket is part
of `amplify/backend.ts`.

Still not implemented, and why: **SMS** has no screen anywhere in the export (only
`sms.template`, with no view and no action), so there is nothing to reach without
a gateway; **WebRTC calls**, the **spreadsheet editor** and the **website
builder** are subsystems of their own, not gaps in these apps.

**The sandbox deploys again (2026-10-03).** Three things stood in the way, each
fixed in `amplify/backend.ts`:

- The user pool's update handler sends every schema entry to Cognito as a custom
  attribute to add — "Invalid AttributeDataType input" without a data type,
  "Required custom attributes are not supported" with one. The schema holds only
  the standard email attribute, which every pool already has and Cognito never
  removes, so it is left out of the template (`addPropertyDeletionOverride`).
  Nothing about signing in changed: the live pool's email attribute is still
  String, required, mutable, and email is still the username.
- The Data API policy's description had been renamed (Rodeo → Almirsal). IAM
  cannot change a managed policy's description in place, so CloudFormation must
  replace the policy, and a sandbox stack (deployed without rollback) refuses
  replacements. The deployed text is back, with a comment saying why.
- The SSO session had expired (`aws sso login --profile almirsal`).

All six stacks are `UPDATE_COMPLETE`; the migration trigger added the 12 new
columns and 1 foreign key on Aurora; `verify-backend --db aurora` passes all
13 782 checks; the S3 store round-trips a file on the deployed bucket; and the
compute role holds read, write and delete on it.

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
