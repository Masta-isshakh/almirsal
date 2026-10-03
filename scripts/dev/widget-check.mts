/**
 * Widgets Odoo's views ask for that our renderers draw generically. A widget
 * drawn generically still shows the value, but not the way Odoo draws it.
 *
 * The answer comes from the routing the app itself uses (`widgetKind`) and from
 * the list's own cell branches, so what this calls handled is what a screen
 * actually draws specially — a name the field renderer never sees cannot pass.
 *
 *   npx tsx scripts/dev/widget-check.mts
 */
import { readFileSync } from 'node:fs';
import { getRegistry } from '../../lib/server/registry.js';
import { widgetKind } from '../../components/fields/routing.js';

/** The widgets a list cell draws itself, read from the renderer's own source. */
const listSource = ['components/views/ListView.tsx', 'components/views/form/EmbeddedList.tsx'].map((file) => readFileSync(file, 'utf8')).join('\n');
const listWidgets = new Set([...listSource.matchAll(/column\.widget === '([^']+)'/g)].map((match) => match[1]));
// A number shown as hours or a percentage is formatted, not redrawn.
const formatted = new Set(['float_time', 'percentage', 'monetary']);

const registry = getRegistry();
type Use = { count: number; where: string; kinds: Set<string> };
const used = new Map<string, Use>();

const walk = (node: unknown, model: string, viewType: string): void => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item) => walk(item, model, viewType)); return; }
  const obj = node as Record<string, unknown>;
  if (typeof obj.widget === 'string') {
    const widget = obj.widget;
    const field = registry.models[model]?.fields[String(obj.name ?? '')];
    const entry = used.get(widget) ?? { count: 0, where: `${model}|${viewType}`, kinds: new Set<string>() };
    entry.count += 1;
    const kind = widgetKind(widget, { type: field?.type ?? 'char', selection: field?.selection });
    const drawn = kind !== null || formatted.has(widget) || (viewType === 'list' && listWidgets.has(widget));
    entry.kinds.add(drawn ? String(kind ?? (viewType === 'list' ? 'list cell' : 'formatted')) : 'generic');
    used.set(widget, entry);
  }
  // A nested view (a one2many's list) is read against the related model.
  const nested = obj.views as Record<string, { type?: string; body?: unknown; columns?: unknown }> | undefined;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const relation = registry.models[model]?.fields[String(obj.name ?? '')]?.relation;
    if (relation) {
      for (const [type, view] of Object.entries(nested)) walk(view, relation, type);
      return;
    }
  }
  Object.values(obj).forEach((value) => { if (value && typeof value === 'object') walk(value, model, viewType); });
};
for (const view of Object.values(registry.views)) walk(view.arch, view.model, view.type);

const generic = [...used.entries()].filter(([, info]) => info.kinds.has('generic')).sort((a, b) => b[1].count - a[1].count);
console.log(`${used.size} widgets used, ${generic.length} drawn generically somewhere`);
for (const [widget, info] of generic) console.log(`  ${String(info.count).padStart(4)}  ${widget}  (first: ${info.where})`);
