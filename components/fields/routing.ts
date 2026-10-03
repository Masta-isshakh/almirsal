import type { FieldDef } from '@engine/registry/types';

/**
 * Which control draws a widget. Odoo names many flavours of the same control —
 * `many2one_avatar_user`, `many2one_avatar_employee` and `many2many_avatar_user`
 * are all avatars — so the mapping is patterns, not a list of names.
 *
 * `Field` renders by the kind this returns, and the widget audit
 * (`scripts/dev/widget-check.mts`) asks the same question, so what the audit
 * calls handled is exactly what the screen draws specially.
 */
export type WidgetKind =
  | 'relative_date' | 'open_record' | 'selection_badge' | 'priority' | 'tags' | 'many2many_checkboxes' | 'groups'
  | 'badge' | 'image' | 'toggle' | 'favorite' | 'color' | 'progressbar' | 'percentpie' | 'clipboard' | 'remaining_days'
  | 'tax_totals' | 'payments' | 'x2many_buttons' | 'analytic_distribution' | 'activity_exception' | 'presence_status'
  | 'nothing' | 'tax_mode' | 'daterange' | 'link' | 'code' | 'badges_many2one' | 'many2one_avatar' | 'many2one'
  | 'radio' | 'statusbar' | 'handle' | 'boolean' | 'selection' | 'date' | 'html' | 'float_time' | 'percentage' | 'type' | 'x2many'
  | 'actionable_errors' | 'timezone' | 'shortcut' | 'identifiers' | 'statistics' | 'rounding_warning' | 'org_chart' | 'resume' | 'skills'
  | 'file_size';

export function widgetKind(widget: string, field: Pick<FieldDef, 'type' | 'selection'>): WidgetKind | null {
  if (!widget) return null;
  // A widget named after the field's own type asks for the plain control.
  if (widget === field.type) return 'type';
  if (widget === 'relative_date') return 'relative_date';
  if (widget === 'open_move_widget' || widget === 'line_open_move_widget' || widget === 'matching_link_widget') return 'open_record';
  if (/selection.*badge|badges_selection|(^|_)state_selection|account_type_selection|filterable_selection|_badges?$|smiley_badge/.test(widget) && field.selection) return 'selection_badge';
  if (widget === 'priority' || widget === 'priority_switch') return 'priority';
  // `helpdesk_sla_many2many_tags`, `planning_many2many_avatar_resource`: the
  // flavour name can come before the widget it is a flavour of.
  if (/many2many_tags|many2many_avatar|tax_tags/.test(widget)) return 'tags';
  if (widget === 'many2many_checkboxes') return 'many2many_checkboxes';
  if (widget === 'res_user_group_ids') return 'groups';
  if (widget === 'badge' || widget === 'label_selection') return 'badge';
  if (widget === 'image' || widget === 'contact_image' || widget === 'image_url') return 'image';
  if (widget === 'boolean_toggle') return 'toggle';
  if (widget === 'boolean_favorite' || /favorite|favourite/.test(widget)) return 'favorite';
  // A checkbox by another name: the settings page's module switches, a to-do's
  // done mark. The control Odoo draws is the checkbox we draw.
  if (widget === 'upgrade_boolean' || widget === 'boolean_checkbox' || widget === 'todo_done_checkmark') return 'boolean';
  // A boolean by another name is still a checkbox or a switch.
  if (field.type === 'boolean' && /boolean|flag|toggle|icon|checkmark/.test(widget)) return /toggle|icon/.test(widget) ? 'toggle' : 'boolean';
  // A selection or a plain value under a named widget keeps its own control.
  if (field.type === 'selection' && /selection|selector|configurator|type_icon/.test(widget)) return 'selection';
  // A size in bytes reads as "1.2 MB", a scheduled date as a date.
  if (field.type === 'integer' && /size$/.test(widget)) return 'file_size';
  if ((field.type === 'char' || field.type === 'datetime') && /date$/.test(widget)) return 'date';
  if (field.type === 'json' && /details|formatted/.test(widget)) return 'code';
  if ((field.type === 'char' || field.type === 'integer' || field.type === 'float') && /selector|flag|icon|description|field$|duration/.test(widget)) return 'type';
  if (field.type === 'datetime' && /date_range|planned_date/.test(widget)) return 'daterange';
  // `horizontal` selections (a receipt's kind, a working-schedule kind) are
  // Odoo's radio row.
  if (widget === 'radio' || widget === 'receipt_selector' || widget === 'calendar_type_confirm_radio') return 'radio';
  // The form header draws the status bar, with or without the duration Odoo
  // adds beside it.
  if (/statusbar/.test(widget)) return 'statusbar';
  if (widget === 'handle') return 'handle';
  // `date_dynamic_min` is a date that will not go before another field's date.
  if (widget === 'formatted_date' || widget === 'date_dynamic_min') return 'date';
  // Html by another name: a knowledge article's body, a composer's message, a
  // report layout's preview, the audit trail's body.
  if (widget === 'text' || widget === 'html_mail' || widget === 'section_and_note_text' || /_label_text$/.test(widget)) return 'html';
  if ((field.type === 'html' || field.type === 'text') && /html|body|preview|wrapper|composer|description|grouped_view/.test(widget)) return 'html';
  // A one2many by another name is still the embedded list: an employee's
  // resume, a sale order's lines, an invoice's labelled lines.
  if (/_o2m$|_one2many$|^one2many$|^many2many$/.test(widget) && (field.type === 'one2many' || field.type === 'many2many')) return 'x2many';
  // A selection over a relation is a record picker; over a plain field it is
  // the dropdown.
  if (widget === 'selection' || widget === 'selection_badge') return field.type === 'many2one' ? 'many2one' : 'selection';
  if (/background_image|_image$|image_with/.test(widget)) return 'image';
  // Timesheet hours are typed and shown as 01:30, like Odoo's float_time.
  if (widget === 'timesheet_uom' || widget === 'timesheet_uom_no_toggle') return 'float_time';
  if (/factor_percent$/.test(widget)) return 'percentage';
  if (widget === 'color_picker' || widget === 'color') return 'color';
  if (widget === 'progressbar') return 'progressbar';
  if (widget === 'percentpie') return 'percentpie';
  if (widget.startsWith('CopyClipboard')) return 'clipboard';
  if (widget === 'remaining_days') return 'remaining_days';
  if (widget === 'account-tax-totals-field') return 'tax_totals';
  if (widget === 'payment') return 'payments';
  if (widget === 'x2many_buttons') return 'x2many_buttons';
  if (widget === 'analytic_distribution') return 'analytic_distribution';
  if (widget === 'activity_exception') return 'activity_exception';
  if (widget === 'actionable_errors') return 'actionable_errors';
  // The user's timezone with the warning Odoo shows when the browser disagrees.
  if (widget === 'timezone_mismatch') return 'timezone';
  // A canned response's shortcut reads as ":hello".
  if (widget === 'shortcut') return 'shortcut';
  if (widget.startsWith('additional_identifiers')) return 'identifiers';
  if (widget === 'contact_statistics') return 'statistics';
  if (widget === 'open_decimal_precision_button') return 'rounding_warning';
  if (widget === 'hr_org_chart') return 'org_chart';
  if (widget === 'resume_one2many') return 'resume';
  if (widget === 'skills_one2many') return 'skills';
  if (widget === 'hr_presence_status') return 'presence_status';
  // Odoo's extra totals line is drawn by the tax totals table already.
  if (widget === 'sale-extra-totals') return 'nothing';
  if (widget === 'document_tax_mode_selector') return 'tax_mode';
  if (widget === 'daterange') return 'daterange';
  if (widget === 'url' || widget === 'email' || widget === 'phone') return 'link';
  if (widget === 'ace' || widget === 'domain' || widget === 'code_editor' || widget === 'json') return 'code';
  if (widget === 'badges_many2one' && field.type === 'many2one') return 'badges_many2one';
  if (widget.startsWith('many2one_avatar') && field.type === 'many2one') return 'many2one_avatar';
  // Partner, product, bank and barcode pickers are many2ones with a name of
  // their own in Odoo; the control is the same.
  if (field.type === 'many2one' && /partner|product|bank|barcode|project|employee|user|uom|m2o|M2O|match|selector|cell|certificate|template|version|stage|line/i.test(widget)) return 'many2one';
  // Last: a named widget over a relation field is still that relation's
  // control — the embedded list for a one2many, tags for a many2many.
  if (field.type === 'one2many' || field.type === 'many2many') return 'x2many';
  // A float shown by a named widget is still a number, a date still a date.
  if ((field.type === 'float' || field.type === 'integer' || field.type === 'monetary') && /float|amount|percent|uom/.test(widget)) return 'type';
  return null;
}
