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
  mirroring, `[CODE] Name`), users, taxes (defaults incl. a tax group).
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
  text search via `filter_domain`, Filters / Group By panel), pager, view
  switcher.
- List view: sticky sortable header, optional columns, decorations, badges,
  tags, avatars, priority stars, footer sums via `read_group`, folded group
  headers with counts and sums, sample-data empty state (B-8).
- Kanban view (from the card summaries), form view (status bar with header
  buttons and stage pipeline, smart buttons, groups, notebook, embedded
  lines, save/discard with Alt+S / Alt+J, `call_button`), field widgets
  (char, text, number, boolean, toggle, selection, radio, date, datetime,
  many2one with autocomplete/quick-create, many2many tags, priority, image),
  chatter (send message / log note, feed with tracking values).
- `/api/rpc` dispatching the A-4 surface; local password sessions or Cognito.

Verified over HTTP on the seeded database: login → home menu → Sales →
create partner, product, quotation `S00001` with lines (1,000 + 200) →
confirm → `sale`, grouped list, Arabic RTL home menu.

**160 tests pass; `tsc --noEmit` is clean under `strict`.**

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

Phase 1 is complete and Phase 2 has started (ORM, list/kanban/form, Sales
hooks). Remaining for the Phase 2 gate: editable embedded lines and the
product catalog on the quotation form, the `sale.advance.payment.inv`
invoice wizard with `account.move` creation, dialogs for `target=new`
actions, search date filters and favorites, the messaging/activities systray
panels, the remaining field widgets, and pixel-parity screenshots.
