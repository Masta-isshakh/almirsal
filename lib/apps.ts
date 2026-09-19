/** App slug (icon file, URL) per root menu xml id (B-5 / C-2). */
export const APP_SLUGS: Record<string, string> = {
  'mail.menu_root_discuss': 'discuss',
  'calendar.mail_menu_calendar': 'calendar',
  'appointment.main_menu_appointments': 'appointments',
  'project_todo.menu_todo_todos': 'todo',
  'knowledge.knowledge_menu_root': 'knowledge',
  'sale.sale_menu_root': 'sales',
  'spreadsheet_dashboard.spreadsheet_dashboard_menu_root': 'dashboards',
  'sale_renting.rental_menu_root': 'rental',
  'accountant.menu_accounting': 'accounting',
  'documents.menu_root': 'documents',
  'project.menu_main_pm': 'project',
  'planning.planning_menu_root': 'planning',
  'helpdesk.menu_helpdesk_root': 'helpdesk',
  'survey.menu_surveys': 'surveys',
  'purchase.menu_purchase_root': 'purchase',
  'sign.menu_document': 'sign',
  'hr.menu_hr_root': 'employees',
  'hr_attendance.menu_hr_attendance_root': 'attendances',
  'fleet.menu_root': 'fleet',
  'approvals.approvals_menu_root': 'approvals',
  'base.menu_management': 'apps',
  'base.menu_administration': 'settings',
};

/** Fallback by app name when an xml id differs from the list above. */
export const APP_SLUGS_BY_NAME: Record<string, string> = {
  Discuss: 'discuss', Calendar: 'calendar', Appointments: 'appointments', 'To-do': 'todo', Knowledge: 'knowledge',
  Sales: 'sales', Dashboards: 'dashboards', Rental: 'rental', Accounting: 'accounting', Documents: 'documents',
  Project: 'project', Planning: 'planning', Helpdesk: 'helpdesk', Surveys: 'surveys', Purchase: 'purchase', Sign: 'sign',
  Employees: 'employees', Attendances: 'attendances', Fleet: 'fleet', Approvals: 'approvals', Apps: 'apps', Settings: 'settings',
};

export function appSlug(xmlId: string, name: string): string {
  return APP_SLUGS[xmlId] ?? APP_SLUGS_BY_NAME[name] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
