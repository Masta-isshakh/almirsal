## PART B — DESIGN SYSTEM (EXACT TOKENS MEASURED ON THE LIVE ODOO 19 INSTANCE, LIGHT THEME)

Implement these as CSS custom properties on `:root` (and a mirrored `[dir=rtl]` build). Values are literal computed styles.

### B-1. Color palette

| Token | Value | Where it is used |
|---|---|---|
| `--o-brand-primary` | `#714B67` (rgb 113,75,103) — Odoo purple | primary buttons (New, Send, Confirm, Save, Meeting, Invite, Send message, Log note in some states), search facet label chip, focus outlines, notebook tab text, active app link accents |
| `--o-brand-primary-hover` | `#5f3f57` | hover of primary buttons |
| `--o-brand-secondary` / links | `#017E84` (rgb 1,126,132) — teal | links (`a`), breadcrumb parent links, view-switcher active border, "Add Line"/"Add Section"/"Catalog" links, sidebar active text, app-tile link color, pivot/graph active toggles |
| `--o-brand-lightsecondary` | `#E6F2F3` (rgb 230,242,243) | active view-switcher button background, active stage chip background, active sidebar item background (Discuss), Tax Excl/Incl active toggle |
| `--o-body-bg` | `#F9FAFB` (rgb 249,250,251) | page/body background, list header background, kanban renderer background, chatter background, form status bar background, settings sidebar |
| `--o-white` | `#FFFFFF` | navbar, control panel, sheet, cards, dialogs, search input |
| `--o-text` | `#111827` (rgb 17,24,39) | body text |
| `--o-text-heading` | `#000000` | h1/h2, list headers, footer aggregates |
| `--o-text-muted` | `rgba(55,65,81,0.76)` | `.text-muted` (kanban subtitles, help text, breadcrumbs inactive) |
| `--o-border` | `#D8DADD` (rgb 216,218,221) | all borders: control panel bottom, sheet, cards, inputs, search bar, table header bottom, tabs |
| `--o-gray-200` | `#E7E9ED` (rgb 231,233,237) | secondary buttons background, search facet background, home menu background base, inactive stage chips, settings section header bars |
| `--o-gray-100` | `#F3F4F6` | hover rows, dropdown item hover |
| `--o-success` | `#28A745` (rgb 40,167,69) / Bootstrap `text-bg-success` | badges "Sales Order/Paid/Full", check-in button (#28a745 green), progress bar success |
| `--o-info` | `#17A2B8` (rgb 23,162,184) | badge `text-bg-info` (Quotation, To Invoice), decoration-info text |
| `--o-warning` | `#FFC107` / text `#5D3F00` on `#FFF3CD` | alert-warning banners (trial banner, unread banner), badges warning (partial), decoration-warning |
| `--o-danger` | `#DC3545` (rgb 220,53,69) | systray counter pill, decoration-danger, late activities, delete actions, calendar today badge (#E7515A-ish red circle) |
| `--o-purple-light` (kanban/sample) | `#EDE9F0` | sample-data blurred backgrounds |
| Discuss message bubble | `#E8F6F8` (rgb 232,246,248) | received message bubble background (radius 0 7.5px 7.5px 7.5px) |
| Settings sidebar active | text `#017E84`, bg `#E6F2F3` | |
| Kanban color swatches (12) | 0 none (white w/ border), 1 `#F06050` red, 2 `#F4A460` orange, 3 `#F7CD1F` yellow, 4 `#6CC1ED` light blue, 5 `#814968` dark purple, 6 `#EB7E7F` salmon, 7 `#2C8397` teal, 8 `#475577` dark blue, 9 `#D6145F` fuchsia, 10 `#30C381` green, 11 `#9365B8` purple | `kanban_color_picker`, tags `color_field`, calendar attendee colors, project/stage colors, journal dashboard colors |
| Gantt pill colors | same 12-color palette by role/resource, unavailability hatch `repeating-linear-gradient(45deg, rgba(0,0,0,.05) …)` | |
| Chart palette (Chart.js) | `#1f77b4 #ff7f0e #aec7e8 #ffbb78 #2ca02c #98df8a #d62728 #ff9896 #9467bd #c5b0d5 #8c564b #c49c94 #e377c2 #f7b6d2 #7f7f7f #c7c7c7 #bcbd22 #dbdb8d #17becf #9edae5` (D3 category20, at 0.8 alpha in dashboards) | graph views, dashboards |
| Home menu background | `#E7E9ED` + `background-light.svg` (soft lavender-grey gradient `#E9E8F0 → #DEDCE8` with two diagonal white bands at ~30°) | `/odoo` home, login page, kiosk |
| Avatar generator | square, white bold initial on a saturated color from `hsl(hash(name) % 360, 68%, 52%)`; online dot 8px `#28A745` bottom-right | users/employees/partners without photo |

### B-2. Typography

- Font stack (body): `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, "Noto Sans", Arial, "Odoo Unicode Support Noto", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"`. Headings (h1–h3, empty-state titles): `"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`. Ship Noto Sans + Noto Sans Arabic as fallback so Arabic renders identically on all OSes.
- Base: `14px / 21px` (line-height 1.5), weight 400, color `#111827`.
- Sizes: navbar app name `16.8px/26px` (1.2rem); breadcrumb current `16.8px/25.2px`; breadcrumb parent link `13px/16.25px` weight 500; form record title h1 `33.6px/40.32px` weight 500 (2.4rem); empty-state title h2 `21px/25.2px` weight 500; empty-state paragraph `16.1px/24.15px`; labels `14px` weight 500; buttons `14px` weight 500; badges `11.9px` weight 500 (list) / `9.8px` (systray counter); kanban card title `17.5px` (`fs-5`) bold; small text `12.25px` (`.small`, 0.875em); dashboard KPI number `32px` light; section titles on dashboards `20px` bold teal-blue `#1F5F8B`-like.
- Letter-spacing normal; no uppercase transforms except dashboard sidebar section names (uppercase bold 12px).

### B-3. Spacing, radius, shadows

- Base unit 4px. Control panel padding `8px 16px 16px`, gap `16px`; sheet padding `24px`; kanban renderer padding `8px`; card padding `8px`, card margin `4px 8px`; list cell padding `8px 4.8px 8px 16px` (first cell 16px left); embedded list cell `8px 4.8px 8px 24px`; settings block padding `16px 24px`.
- Border radius: buttons/inputs/cards/sheet `4px`; app tiles `6px`; dropdown panels/dialog `8px`; badges pill `800px`; checkbox `3.5px`; avatar 26px navbar `4px`; kanban avatar circle 50%.
- Borders `0.6667px` (renders as 1px hairline) `#D8DADD`.
- Shadows: app icon `inset 0 0 0 1px rgba(0,0,0,.2), 0 1px 1px rgba(0,0,0,.02), 0 2px 2px rgba(0,0,0,.02), 0 4px 4px rgba(0,0,0,.02), 0 8px 8px rgba(0,0,0,.02), 0 16px 16px rgba(0,0,0,.02)`; dropdown/dialog `0 8px 24px rgba(0,0,0,.12)`; kanban card hover `0 2px 6px rgba(0,0,0,.08)`; sticky headers `0 1px 0 #D8DADD`.
- Heights: navbar `46px` (padding 10px 0); control panel `61px`; buttons `36px` (padding 7px 14px); inputs in forms `24px` line with bottom border only; search bar `36px`; list header `40px`, rows `40.67px`, footer `37px`; stage chips `33px`; notebook tabs `38px`; chatter topbar `52px`; app tile `115×141.67px`, icon `70×70px` (padding 10px); Discuss sidebar `300px`; Documents/Knowledge sidebar `300px`; Dashboards sidebar `200px`; settings sidebar `150px`; search box `376px`.

### B-4. Components (exact)

- **Buttons**: `.btn` 14px/500, radius 4px, padding 7px 14px, border 1px. Primary: bg/border `#714B67`, text white; hover darker. Secondary: bg/border `#E7E9ED`, text `#111827`; hover `#D8DADD`. Outline-primary (form "New" in control panel): transparent bg, border+text `#714B67`. Link buttons: text `#017E84`, no border. Icon-only buttons 36×36. Split buttons (New ▾ in Documents). Disabled: opacity .65.
- **Inputs (form)**: no box; bottom border 1px `#E7E9ED` at rest, `#000` on focus (many2one shows `#E7E9ED` at rest); placeholder muted; many2one caret `▾` at the right; date fields with calendar icon on the left; monetary with currency label after number; textarea auto-grow. Inputs inside dialogs/settings/kiosk: full bordered boxes radius 4px `#D8DADD`.
- **Checkbox**: 14×14, border `#D8DADD`, radius 3.5px, checked bg `#714B67`; toggle (`boolean_toggle`): 30×16 pill, on = `#714B67`.
- **Badges**: `badge rounded-pill text-bg-{info|success|warning|danger|secondary|light}`; `label_selection` mapping per view (e.g. sale state draft→info, sale→success, cancel→default).
- **Alerts**: `alert-info` (`#D1ECF1` bg) with icon, `alert-warning` (`#FFF3CD` bg, `#5D3F00` text), `alert-danger`, `alert-success`; dismissible ✕.
- **Tooltips**: dark `#111827` bg, white 12px text, radius 4px, arrow.
- **Dropdown menus**: white, radius 8px, shadow, items 14px with 8px 16px padding, hover `#F3F4F6`; section headers uppercase muted 11px; keyboard navigation. Odoo 19 renders large "bottom-sheet-like" panels for the user menu / channel actions / search date picker: centered panel 500px wide, radius 12px, drag handle bar at top (a 76×4px grey pill), items 16px tall rows.
- **Dialog (modal)**: header title 19.6px + ✕; body; footer buttons left-aligned (primary first); sizes sm 500 / md 800 / lg 1000 / xl 1140; backdrop `rgba(0,0,0,.5)`; nested dialogs stack with offset.
- **Toast notifications**: bottom-right? (Odoo 17+: top-right under navbar), 4 s, colored left border by type, close ✕, "sticky" stays.
- **Tables (list)**: header bg `#F9FAFB`, th weight 500 black, border-bottom `#D8DADD`; rows white with hairline `rgba(0,0,0,.02)`; hover row `#F3F4F6`; selected row `#E6F2F3`; group header rows bold with counts and `▸/▾`; footer aggregates weight 500.
- **Kanban card**: white, border `#D8DADD`, radius 4px (grouped) / 0 (some ungrouped older templates), padding 8px, hover shadow; left color stripe 3px when colored; ribbons; footer row with muted small texts and badges; ⋮ menu appears on hover top-right.
- **Stage pipeline (statusbar)**: chips with arrow shape (`clip-path` chevron), 33px tall, inactive bg `#E7E9ED` at 50% opacity, current `#E6F2F3` black bold; clickable when allowed; overflow collapses into a dropdown "…".
- **Smart buttons**: 36px tall white boxes with left icon (`fa`), value bold + label small stacked, border `#D8DADD`, hover bg `#F3F4F6`.
- **Notebook tabs**: text `#714B67`, active tab: top border `#714B67`, side borders `#D8DADD`, bottom border white; content padding 16px 0.
- **Chatter**: composer box white with border; message row hover shows action bar; notes have `#FCF8E3`-like background; date separators centered with lines; avatars 36px.
- **Search facets**: chip bg `#E7E9ED` radius 4px 23px tall; left label part bg `#714B67` white with icon (funnel for filter, layers for group-by, star for favorite, magnifier/field name for field search); values joined by " or "; ✕ remove.
- **Pager**: `1-80 / 250` text 14px + `‹ ›` icon buttons 36px with border.
- **Sidebar (search panel)**: 215px, bg `#F9FAFB`, sections with header (uppercase muted), items with counters, active item teal text + `#E6F2F3` bg pill, expand carets.
- **Empty state (`o_nocontent_help`)**: centered block max 800px: illustration (smiling document SVG in purple `#714B67`), h2 21px, p 16.1px, primary CTA when defined; behind it the sample data rows at 6% opacity.
- **Onboarding video card** (Sales quotations, etc.): 400×225 rounded 16px image with play icon centered above the empty-state text.
- **Loading**: `.o_loading_indicator` thin purple bar; skeleton none; buttons show spinner on async.
- **Scrollbars**: thin (8px) overlay style.

### B-5. App icons (22)

Each app icon is a 70×70 white rounded square (radius 6px) with a flat 2–3 color glyph (the Odoo 17+ icon set). Recreate them as SVGs with these glyphs/colors (do not ship raster copies of Odoo's PNGs; redraw): Discuss = orange speech-drop (`#F18E42`→`#EB5B25`); Calendar = "31" (purple `#714B67` and orange gradient); Appointments = "31" with green check; To-do = teal pencil stroke; Knowledge = purple/teal bookmark ribbon; Sales = purple/orange/pink bars chart; Dashboards = purple/pink/blue tiles; Rental = teal/purple key; Accounting = teal/purple percent sign; Documents = stacked colored sheets (blue/orange/pink); Project = teal check mark; Planning = purple/teal arrows with a drop; Helpdesk = teal cross/plus; Surveys = blue/red bars; Purchase = purple/teal credit card; Sign = teal/blue signature stroke; Employees = purple/teal/yellow people; Attendances = orange/brown person with clock; Fleet = purple steering wheel; Approvals = teal check + purple person; Apps = four-quadrant circle (purple/teal/red/blue); Settings = orange hexagon nut with hole. Captions under icons are the app names (EN/AR).

### B-6. Layout grid & responsiveness

- Breakpoints (Bootstrap): sm 576, md 768, lg 992, xl 1200, xxl 1400. Form: below md the two-column groups stack; chatter moves below the sheet (and right side ≥ 1500 px); kanban single column below md; navbar collapses app menus into a burger; control panel wraps (search box full width on md); list becomes horizontally scrollable; dialogs go fullscreen on mobile; home menu 3 icons per row on phones.
- Home menu grid: 6 tiles per row, tile 141.67×115, gap 0, container 850px centered, top margin 24px, trial banner above.
- Max content widths: form sheet 1400px; settings content 1200px; financial report sheet 800px; Knowledge article 900px (unless "Full Width").

### B-7. Search panel dropdown (exact)

Panel width ~780px under the search box, 3 equal columns with headers with icon: "Filters" (funnel), "Group By" (layers), "Favorites" (star). Items 14px, active items show ✓ at the left; separators are 1px lines between filter groups; expandable items show a caret at the right and open a nested list (date periods: last 3 months by name, quarters Q4…Q1, years with checkboxes; group-by date interval: Year/Quarter/Month/Week/Day); bottom of Filters: "Add Custom Filter" link (dialog); bottom of Group By: "Custom Group ▾" select of all storable fields; Favorites: "Save current search ▾" → name input (prefilled with action name), "Default filter" and "Shared" checkboxes, "Save"/"Edit" buttons; saved favorites listed with ✓ and trash icon.

### B-8. Empty & sample states

Views with `sample="1"` show ghost sample records (Lorem-ipsum-like names such as "REF0001", "John Miller", "Wendi Baltz", "Henry Campbell", "Thomas Passot", "Carrie Helle", "In massa", "Integer vitae", "Viverra nam", "Laoreet id", "Volutpat blandit", amounts 10k–100k) at 6% opacity beneath the centered help block (`help` text of the action, Part E). Views without sample data show only the help block. Kanban empty columns show "+" placeholders.

### B-9. RTL (Arabic) rules

`<html dir="rtl" lang="ar">` when the user language is `ar_001`. Build the RTL stylesheet with `rtlcss` from the LTR one (all `left/right`, margins, paddings, borders, text-align, floats, transforms flipped). Specifics observed: navbar order reversed (app icon+name and menu sections at the right, systray at the left with avatar leftmost); control panel: primary button + breadcrumb on the right, view switcher on the left; search box centered with the magnifier on the right and the dropdown caret on the left; list: selector column on the right, optional-columns toggler at the far left, text right-aligned, amounts right-aligned as in LTR; form: status bar buttons on the right, stage chips on the left with chevrons pointing left; labels right-aligned; notebook tabs start from the right; kanban columns flow right-to-left; gantt timeline flows right-to-left; chatter unchanged; icons that imply direction (arrows, carets, chevrons, back) mirrored; dates in Arabic-Indic digits (e.g. `٢٤ أغسطس، ١٠:٣٥ ص`), month names Arabic (يناير…ديسمبر), week start Saturday (`week_start=6` in ar_001); numbers/amounts keep Latin digits; date format `%d/%m/%Y` in ar vs `%m/%d/%Y` in en. Untranslated Odoo strings must be translated in the clone.

### B-10. Login page (`/web/login`)

Centered card 246px wide (white, radius 4px, padding 24px, shadow) on the lavender background: company logo placeholder ("📷 Your logo" text-logo in purple when no logo), separator, "Email" label + input (placeholder "Enter your email"), "Password" label + "Reset Password" link right + input (placeholder "Enter your password") + eye toggle, primary full-width "Log in" button, "Don't have an account?" link (signup disabled → hidden or leads to "Sign up is not allowed"), "- or -", outlined "Use a Passkey" button with QR icon, separator, "Powered by Odoo" → replace with "Powered by Rodeo Drive". Error state: red alert "Wrong login/password". Reset password page, signup page, "Set password" invitation page.


---

