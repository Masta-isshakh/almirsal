# MASTER BUILD PROMPT — "RODEO ERP": PIXEL-EXACT, FEATURE-COMPLETE CLONE OF ODOO 19 (saas~19.4 Enterprise) ON AWS AMPLIFY GEN 2 + NEXT.JS APP ROUTER

> **Source of truth.** Every line of this document was extracted programmatically and visually from a live Odoo 19.4 Enterprise instance (database `masta`, apps: Discuss, Calendar, Appointments, To-do, Knowledge, Sales, Dashboards, Rental, Accounting, Documents, Project, Planning, Helpdesk, Surveys, Purchase, Sign, Employees, Attendances, Fleet, Approvals, Apps, Settings). It contains the complete menu tree (331 menu items), 277 screens/actions, 664 view definitions (list/kanban/form/search/calendar/pivot/graph/gantt/activity/map/cohort/hierarchy/grid), ~4,000 fields with English + Arabic labels, every button with its visibility condition, every filter and group-by, every settings option, the default seed data, the exact CSS design tokens, and the behaviour of the custom (non-generic) screens.
>
> **How to read it.** Part A = architecture & engine you must build. Part B = the design system (exact colors, sizes, fonts, components). Part C = the global shell and every generic behaviour + the custom screens. Part D = cross-app business logic (state machines, integrations). Part E = the 22 applications, screen by screen, view by view, field by field (generated from the live instance). Part F = the Settings pages. Part G = shared dialogs. Part H = the data-model reference (every field). Part I = seed data. Part J = QA checklist and build order.
>
> **Non-negotiable rules.**
> 1. Nothing in Part E–I is optional. Every menu, screen, view, column, field, button, filter, group-by, tab, smart button, wizard, setting, and seed record listed must exist and work. If a button says `→ calls action_confirm`, implement the business method with the semantics described in Part D.
> 2. The UI must be visually indistinguishable from Odoo 19 at 1280×609 and at 1920×1080: same layout, spacing, colors, typography, icons, hover states, badges, empty states, dialogs, toasts, keyboard shortcuts. Use Part B tokens literally.
> 3. The app is bilingual: English (LTR, default for new users = `en_US`) and Arabic (RTL, `ar_001`). Every string in the UI has EN and AR variants — the specs are written as `English / العربية`. The layout mirrors completely in RTL (see B-9). Dates in Arabic use Arabic-Indic digits; amounts always use Latin digits with `,` thousands and `.` decimals and the currency label after the number (`0.00 QR`).
> 4. Everything is dynamic: one metadata-driven engine renders all models/views; business rules live in server-side functions; all data is persisted; nothing is mocked or hard-coded; all apps share the same partners, products, users, companies, currencies, attachments, messages, activities and followers.
> 5. Reliability: every mutation is transactional; sequences never produce duplicates; state transitions are validated server-side; access rights are enforced server-side; every list is paginated; every long operation shows progress; every error shows an Odoo-style dialog (title "Validation Error" / "Access Error" / "User Error" + message).
> 6. Do not skip, summarise or "simplify" a screen because it is large. Where this document says "same as V0xx", reuse that view definition.

## TABLE OF CONTENTS

- PART A — Architecture: the metadata engine (stack, registry, ORM, client engine, directory layout, jobs, tests)
- PART B — Design system (exact colors, typography, spacing, components, icons, RTL, login page)
- PART C — Global shell, generic behaviours, custom screens (Discuss, Knowledge, Dashboards, Documents, Sign, Attendances/Kiosk, Accounting dashboard & financial reports, Helpdesk/Approvals/Project/Planning/Surveys/Appointments/Fleet/Employees/Apps specifics) + C-13 financial report definitions
- PART D — Cross-app business logic (numbering, state machines, buttons, computed fields, integrations, reports)
- PART E — THE 22 APPLICATIONS, screen by screen (generated from the live instance): navigation trees, screens S001…S277, views V001…V664 with every column/field/button/tab/filter/group-by
- PART F — Settings pages (every setting of every app) + screens reached from Settings
- PART G — Shared dialogs (Schedule Activity, Send message composer, followers, export, My Preferences, calendar quick create) + other deep-linked screens
- PART H — Data model reference (every field of every model with EN/AR labels, types, relations, selections) + printable reports
- PART I — Default / seed data
- PART J — Build order, quality gates, acceptance checklist


---

