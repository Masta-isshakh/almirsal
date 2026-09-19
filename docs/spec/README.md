# Spec reference (prose parts)

Extracted verbatim from `ODOO_CLONE_MASTER_PROMPT_1.md` so a session can load
the behaviour spec (~170 KB) without paging through the 2.4 MB master file.

| File | Part | What it defines |
|---|---|---|
| `A-architecture.md` | A | Stack, registry types, ORM semantics, client engine components, jobs, tests |
| `B-design-system.md` | B | Tokens, typography, components, app icons, responsiveness, search panel, empty states, RTL rules, login page |
| `C-shell-and-custom-screens.md` | C | Navbar/systray/menus, home menu, command palette, action manager & URLs, chatter features, settings page, auth flows, the custom client actions (Discuss, Knowledge, Dashboards, Documents, Sign, Attendances, Accounting dashboard & financial reports, app-specific bits), C-13 financial report definitions |
| `D-business-logic.md` | D | Numbering, state machines, button methods, computed fields and integrations per app |
| `J-build-order.md` | J | Build phases with gates, definition of done, how to consume the spec |

Parts E, F, G, H and I are generated from the live instance and are fully
represented by `registry/odoo_spec.json` (loaded by
`packages/engine/registry/spec-loader.ts`); the master file's rendering of
them adds no information beyond the export.
