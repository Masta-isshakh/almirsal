/**
 * Materialises the typed registry and the i18n catalogs from the companion
 * export, so they can be inspected, diffed and imported without re-running
 * the loader at startup.
 *
 *   npx tsx scripts/generate-registry.ts
 *
 * Outputs:
 *   registry/generated/{models,views,actions,menus,groups,reports,
 *                       account-reports,app-icons,session}.json
 *   registry/generated/seed/<model>.json
 *   messages/{en,ar}.json
 *   registry/generated/REPORT.md — coverage and inference summary
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectMessages, loadRegistry, type RawSpec } from '../packages/engine/registry/spec-loader.js';

const root = resolve(import.meta.dirname, '..');
const spec = JSON.parse(readFileSync(resolve(root, 'registry/odoo_spec.json'), 'utf8')) as RawSpec;
const registry = loadRegistry(spec);
const messages = collectMessages(spec);

const out = resolve(root, 'registry/generated');
mkdirSync(resolve(out, 'seed'), { recursive: true });
mkdirSync(resolve(root, 'messages'), { recursive: true });

const write = (path: string, data: unknown) =>
  writeFileSync(resolve(root, path), `${JSON.stringify(data, null, 1)}\n`, 'utf8');

write('registry/generated/session.json', registry.session);
write('registry/generated/models.json', registry.models);
write('registry/generated/views.json', registry.views);
write('registry/generated/actions.json', registry.actions);
write('registry/generated/menus.json', registry.menus);
write('registry/generated/groups.json', registry.groups);
write('registry/generated/reports.json', registry.reports);
write('registry/generated/account-reports.json', registry.accountReports);
write('registry/generated/app-icons.json', registry.appIcons);
for (const [model, records] of Object.entries(registry.seed)) {
  write(`registry/generated/seed/${model}.json`, records);
}
write('messages/en.json', messages.en);
write('messages/ar.json', messages.ar);

/* ---- coverage report ---- */
const models = Object.values(registry.models);
const fields = models.flatMap((model) => Object.values(model.fields));
const inferred = fields.filter((field) => field.inferred);
const uncaptured = new Set<string>();
for (const field of fields) {
  if (field.relation && !registry.models[field.relation]) uncaptured.add(field.relation);
}
const viewsByType: Record<string, number> = {};
for (const view of Object.values(registry.views)) viewsByType[view.type] = (viewsByType[view.type] ?? 0) + 1;
const widgets = new Set<string>();
const walk = (node: unknown): void => {
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record.widget === 'string') widgets.add(record.widget);
  Object.values(record).forEach(walk);
};
walk(registry.views);

const lines = [
  '# Registry generation report',
  '',
  `Source: \`registry/odoo_spec.json\` (${registry.session.version}, db \`${registry.session.db}\`)`,
  '',
  '| Item | Count |',
  '|---|---|',
  `| Apps (root menus) | ${registry.menus.length} |`,
  `| Menus | ${Object.keys(registry.menuIndex).length} |`,
  `| Actions | ${Object.keys(registry.actions).length} |`,
  `| Views | ${Object.keys(registry.views).length} (${Object.entries(viewsByType).map(([type, count]) => `${type} ${count}`).join(', ')}) |`,
  `| Models | ${models.length} |`,
  `| Fields captured | ${fields.length - inferred.length} |`,
  `| Fields synthesized (one2many back-references) | ${inferred.length} |`,
  `| Distinct field widgets | ${widgets.size} |`,
  `| Groups | ${Object.keys(registry.groups).length} |`,
  `| Printable reports | ${registry.reports.length} |`,
  `| Financial reports | ${registry.accountReports.length} |`,
  `| Seed models | ${Object.keys(registry.seed).length} |`,
  `| i18n pairs (EN → AR) | ${Object.keys(messages.ar).length} |`,
  '',
  `## Relations to models the export did not capture (${uncaptured.size})`,
  '',
  'These comodels are referenced by a many2one/x2many but have no field list in the export. They need their fields added from Part H or from Odoo\'s own definitions before the ORM can traverse them.',
  '',
  ...[...uncaptured].sort().map((name) => `- \`${name}\``),
  '',
  '## Synthesized one2many back-references',
  '',
  ...inferred.map((field) => `- \`${field.relation}\` ← \`${field.name}\``).sort(),
  '',
];
writeFileSync(resolve(out, 'REPORT.md'), lines.join('\n'), 'utf8');

console.log(lines.slice(4, 20).join('\n'));
console.log(`\nuncaptured comodels: ${uncaptured.size}; synthesized inverses: ${inferred.length}`);
