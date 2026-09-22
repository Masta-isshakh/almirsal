import type { Registry } from '../engine/registry/types.js';
import { hooksFor } from '../engine/orm/hooks.js';
import { registerBase } from './base/index.js';
import { registerActivities } from './base/activity.js';
import { registerUsers } from './base/users.js';
import { registerSettings } from './base/settings.js';
import { registerSmartButtons } from './base/smart.js';
import { registerSale } from './sale/index.js';
import { registerSaleInvoicing } from './sale/invoice.js';
import { registerAccount } from './account/index.js';
import { registerAccountExtra } from './account/extra.js';
import { registerPurchase } from './purchase/index.js';
import { registerApprovals } from './approvals/index.js';
import { registerHr } from './hr/index.js';
import { registerProject } from './project/index.js';
import { registerCalendar } from './calendar/index.js';
import { registerSignSurveyFleet } from './sign/index.js';
import { registerMisc } from './misc/index.js';

/**
 * Register every app's model hooks (J-1 phase 4 order). Idempotent per
 * process; tests that clear the hook table can call it again.
 */
export function registerApps(registry: Registry): void {
  if (hooksFor('sale.order').methods) return;
  registerBase();
  registerUsers(registry);
  registerActivities();
  registerSettings(registry);
  registerAccount(registry);
  registerAccountExtra();
  registerSale();
  registerSaleInvoicing();
  registerPurchase();
  registerApprovals();
  registerHr();
  registerProject();
  registerCalendar();
  registerSignSurveyFleet();
  registerMisc();
  registerSmartButtons();
}
