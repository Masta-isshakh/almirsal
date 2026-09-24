/**
 * Every label the interface shows that has no Arabic: the export ships some
 * strings untranslated (Odoo's own Arabic pack does not cover them), and they
 * stay in English when the client is switched to Arabic.
 *
 *   npx tsx scripts/dev/i18n-check.mts            # summary + the distinct texts
 *   npx tsx scripts/dev/i18n-check.mts --json out.json
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';
import type { I18n } from '../../packages/engine/i18n/types.js';

const registry = loadRegistry(
  JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8')),
  JSON.parse(readFileSync('registry/extra-models.json', 'utf8')),
);

/** The runtime catalog: `useT()` falls back to it when an export string has no Arabic. */
const catalog: Record<string, string> = JSON.parse(readFileSync('messages/ar.json', 'utf8'));

/**
 * Names that stay in Latin script in Arabic Odoo too: brands, protocols and
 * technical identifiers. Reported separately instead of counted as missing.
 */
const KEEP_LATIN = new Set(['AvaTax', 'BIC/SWIFT', 'Cloudflare Turnstile', 'Client_id', 'Client_key', 'GLN', 'Gelato',
  'URI', 'reCAPTCHA', 'work_permit_name', 'Odoo', 'PEPPOL', 'SEPA', 'ISO20022', 'IBAN', 'QR', 'API', 'UBL', 'XML', 'PDF', 'CSV',
  'Mapbox', 'Token', 'STUN', 'TURN', 'Zoom', 'Gmail', 'Outlook', 'HTML', 'QWeb', 'Noto Sans Mono', 'barcodelookup.com',
  'The', 'toconfirm', 'x', '&nbsp;', '/d', '/ticket', '/search_tickets', 'BE71096123456769', String.raw`BRT *([\d,\.]+)`,
  'e.g. 1234', 'e.g: 12/31/2030', 'e.g. ACzb1d3455b0aar4c7t95f1b6e8', 'e.g. AIabCd5543a0b450ar4c7t95f1b6e8',
  'e.g. email@domain.com, domain.com', 'e.g. https://duolingo.com/course/xyz',
  'European (RF83INV202400001)', 'Legal 3  8.5 x 14 inches', 'Letter 2  8.5 x 11 inches']);

/**
 * Selections whose values are identifiers rather than prose — IANA time
 * zones, EU tax and routing codes, chart templates, font and standard names.
 * Odoo leaves them in Latin too, so they are not reported as missing.
 */
const TECHNICAL_SELECTIONS = new Set(['routing_scheme', 'ubl_cii_tax_exemption_reason_code', 'utm_reference',
  'currency_provider', 'chart_template', 'parent_ref', 'resource_ref', 'font', 'format', 'invoice_edi_format',
  'res_model', 'model', 'model_id', 'res_record']);

/** Time zone and language fields carry identifiers (`Europe/Paris`), whatever the field is called. */
function technicalSelection(field: string): boolean {
  return TECHNICAL_SELECTIONS.has(field) || /(^|_)(tz|lang)$/.test(field);
}

const LATIN = /[A-Za-z]/;
const ARABIC = /[؀-ۿ]/;
/** Counts per kind, and where each English text was found. */
const found = new Map<string, { count: number; kinds: Set<string>; where: string }>();

function check(kind: string, where: string, value: I18n | string | undefined): void {
  if (!value) return;
  const en = typeof value === 'string' ? value : value.en;
  const ar = typeof value === 'string' ? undefined : value.ar;
  if (!en || !LATIN.test(en)) return;
  if (ar && ar !== en && ARABIC.test(ar)) return;
  const fallback = catalog[en];
  if (fallback && fallback !== en && ARABIC.test(fallback)) return;
  if (KEEP_LATIN.has(en.trim())) return;
  const entry = found.get(en) ?? { count: 0, kinds: new Set<string>(), where };
  entry.count += 1;
  entry.kinds.add(kind);
  found.set(en, entry);
}

for (const menu of Object.values(registry.menuIndex)) check('menu', menu.xmlId, menu.name);
for (const action of Object.values(registry.actions)) check('action', action.xmlId, action.name);

for (const [name, model] of Object.entries(registry.models)) {
  check('model', name, model.description);
  for (const field of Object.values(model.fields)) {
    check('field', `${name}.${field.name}`, field.label);
    const path = `${name}.${field.name}`;
    if (technicalSelection(field.name)) continue;
    for (const option of field.selection ?? []) check('selection', path, option.label);
  }
}

/** View architectures carry labels in many shapes; walk them generically. */
const STRING_KEYS = new Set(['string', 'label', 'title', 'placeholder', 'help', 'confirm', 'text']);
function walk(node: unknown, where: string): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, where); return; }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'en' in (value as object) && STRING_KEYS.has(key)) {
      check(`view:${key}`, where, value as I18n);
      continue;
    }
    if (typeof value === 'string' && STRING_KEYS.has(key)) check(`view:${key}`, where, value);
    walk(value, where);
  }
}
for (const view of Object.values(registry.views)) walk(view.arch, `${view.model}|${view.type}`);

/**
 * The second half: strings our own screens pass to `t('…')`. They are keyed
 * by the English text as well, so a missing catalog entry shows English in
 * an Arabic client — which is how the accounting dashboard kept saying
 * "Balance in GL".
 */
const CODE = /\bt\(\s*(['"])(.{2,160}?)\1\s*[),]/g;
function scanSources(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git', '.amplify', '.pglite', 'scripts'].some((skip) => entry.name === skip)) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { scanSources(full); continue; }
    if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(full, 'utf8');
    for (const match of source.matchAll(CODE)) {
      const text = match[2].replace(/\\(['"])/g, '$1');
      check('screen', full, text);
    }
  }
}
for (const dir of ['app', 'components', 'lib']) scanSources(dir);

const rows = [...found.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
const byKind = new Map<string, number>();
for (const [, entry] of rows) for (const kind of entry.kinds) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);

console.log(`${rows.length} distinct English texts without Arabic, ${rows.reduce((sum, [, e]) => sum + e.count, 0)} occurrences`);
console.log([...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(', '));

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(rows.map(([en, e]) => ({ en, count: e.count, kinds: [...e.kinds], where: e.where })), null, 1), 'utf8');
  console.log('written to', process.argv[jsonFlag + 1]);
} else {
  for (const [en, entry] of rows.slice(0, 80)) console.log(`  ${String(entry.count).padStart(3)}  ${[...entry.kinds].join('/')} ${en}`);
}
