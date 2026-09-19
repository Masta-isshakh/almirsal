## PART J — BUILD ORDER, QUALITY GATES AND ACCEPTANCE CHECKLIST

### J-1. Build phases (do them in this order; each phase must pass its gate before the next)

1. **Foundation**: Amplify Gen 2 backend (auth, Aurora Postgres, storage, functions skeleton), Next.js app shell with i18n (EN/AR) + RTL build, design tokens (Part B) as CSS variables, Bootstrap 5 utilities, icon fonts, login page (B-10). Gate: login works, language switch mirrors the layout, Part B tokens verified in a Storybook page showing every component.
2. **Engine core**: registry types, expression evaluator + domain compiler (unit-tested against every expression string in Part E), ORM (create/write/unlink/search_read/read_group/name_search/onchange/default_get/copy/archive/sequences/mixins/access rules), menus & actions loader, URL router, control panel + search view + filters/group-by/favorites, list view, form view, kanban view, field widgets (the full list in A-4 §6), dialogs, chatter, activities, followers, attachments, import/export, command palette, systray menus, home menu, user menu, preferences. Gate: the Sales app (Part E APP 6) is fully usable end-to-end (create product, customer, quotation, send, confirm, invoice via wizard) with pixel-parity screenshots.
3. **Remaining generic views**: calendar, pivot, graph, gantt, activity, map, cohort, grid, hierarchy; settings page engine; PDF report engine + document layout; email (SES) + templates; scheduled jobs framework. Gate: Part E APPs 2, 3, 4, 11, 12, 15, 17 screens render from metadata without app-specific code except their `js_class` behaviours.
4. **Apps in this order** (each with its business methods from Part D, seed data from Part I, settings from Part F): Settings & Users & Companies → Discuss → Calendar → Appointments → To-do → Knowledge → Sales → Rental → Accounting (largest) → Purchase → Project → Planning → Helpdesk → Employees → Attendances → Fleet → Approvals → Sign → Surveys → Documents → Dashboards (spreadsheet renderer) → Apps. Gate per app: the e2e spec of every S-screen of the app passes (A-8), all buttons work, all filters/group-bys produce correct SQL, Arabic labels present, RTL screenshots parity.
5. **Cross-app flows (Part D)** integration tests: quote → order → invoice → payment → bank reconciliation → reports; PO → bill → payment; approval "Create RFQ's" → PO; sale of service → project/task/planning shifts; ticket → task; employee → attendance kiosk → overtime approval; sign request from employee/documents; documents mirroring; dashboards numbers equal to reports.
6. **Polish**: onboarding/empty states & sample data, keyboard shortcuts, tooltips, toasts, error dialogs, debug mode tools, PWA install, push notifications, performance (list of 10k rows paginates in <300 ms; kanban drag <50 ms), accessibility (focus rings, aria labels as in Odoo), mobile layouts.

### J-2. Definition of done (verify every item; the reviewer will compare against the live Odoo instance)

- [ ] Home menu shows the 22 apps in the right order with correct icons/captions (EN/AR) and the trial banner component (configurable).
- [ ] Every one of the 331 menu items in Part E exists at its place in the navbar and opens the listed screen with the listed default filters, view order and empty-state text.
- [ ] Every view definition (V001…V661) renders all listed columns/fields/buttons/tabs/widgets with the listed conditions; optional columns default show/hide states respected; footer sums present; decorations applied.
- [ ] Every form header button and smart button exists with its visibility condition and calls a working server method; every wizard (S-secondary screens) opens with the listed fields and footer buttons.
- [ ] Every search view field/filter/group-by/search panel item exists with the listed domain semantics; date filters produce Odoo's period options; favorites can be saved/shared/defaulted.
- [ ] Every SETTING in Part F exists with its label/help/dependent fields and actually changes behaviour.
- [ ] Every field in Part H exists in the database with the right type/relation/selection/required flags and EN/AR labels; selection values identical.
- [ ] All seed records of Part I exist after a fresh deploy.
- [ ] All custom screens of Part C behave as described (Discuss real-time chat & calls, Knowledge editor with the full powerbox, Dashboards with all widgets, Documents with viewer/actions/requests, Sign editor with drag-drop fields & signing flow & certificate, Attendance kiosk & systray, Accounting dashboard cards & all financial reports with their filters/columns/lines, Helpdesk overview, Approvals dashboard, Planning gantt actions, Surveys builder/results/live session, Appointments booking page, portals).
- [ ] Chatter, activities, followers, attachments, tracking, notifications, email sending/receiving, canned responses, mentions, emojis work on every model that has a chatter in Part E.
- [ ] Numbering, state machines, computed totals, taxes, currency rounding, dates/timezones, access rights and record rules behave as in Part D.
- [ ] PDF reports match Odoo's layouts; XLSX exports open in Excel.
- [ ] Arabic mode: every label translated (use the AR strings in this document; translate the few remaining English ones), full RTL mirroring, Arabic-Indic digits for dates, Latin digits for amounts, Saturday week start.
- [ ] Visual parity: side-by-side screenshots of each screen in EN and AR at 1280×609 differ by <0.5% pixels from the reference (allowing for fonts).
- [ ] No console errors; all mutations transactional; concurrent edits detected; pagination everywhere; loading states; no hard-coded data.

### J-3. How to consume this document with an AI coding agent

Work app by app. For each phase, load Parts A–D once, then only the relevant Part E section plus the Part F/H/I rows for the models involved. Never paraphrase view definitions — transcribe them into registry JSON exactly (or generate them from the companion `odoo_spec.json`). When a behaviour is not spelled out here, replicate Odoo 19 Enterprise's behaviour.
