import { registerBase } from './base/index.js';
import { registerSale } from './sale/index.js';

let registered = false;

/** Register every app's model hooks once per process (J-1 phase 4 order). */
export function registerApps(): void {
  if (registered) return;
  registered = true;
  registerBase();
  registerSale();
}
