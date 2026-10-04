/**
 * Smart-button counters (`statField`, from extra-models `stat_buttons`) and
 * where their value comes from: a SQL expression, a related path, a stored
 * column some code writes, or nothing — a counter with no source would show a
 * wrong number, so it is listed.
 *
 *   npx tsx scripts/dev/stat-counters.mts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRegistry } from '../../lib/server/registry.js';

const registry = getRegistry();
const source: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) source.push(readFileSync(path, 'utf8'));
  }
};
walk('packages/apps');
const code = source.join('\n');

const dead: string[] = [];
let total = 0;
for (const view of Object.values(registry.views)) {
  if (view.arch.type !== 'form') continue;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const button = node as { kind?: string; statField?: string };
    if (button.kind === 'button' && button.statField) {
      total++;
      const field = registry.models[view.model].fields[button.statField];
      const fed = field.sqlExpr || field.related || new RegExp(`['"\s]${button.statField}['"\s:]`).test(code);
      if (!fed) dead.push(`${view.model}.${button.statField}`);
    }
    Object.values(node).forEach(visit);
  };
  visit(view.arch.body);
}
console.log(`${total} counters, ${dead.length} without a source`);
console.log([...new Set(dead)].sort().join('\n'));
