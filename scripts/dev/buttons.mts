import { readFileSync, writeFileSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';
import { hooksFor } from '../../packages/engine/orm/hooks.js';
import { registerApps } from '../../packages/apps/index.js';
const r = loadRegistry(JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8')), JSON.parse(readFileSync('registry/extra-models.json', 'utf8')));
registerApps(r);
const out: Record<string, Record<string, { label: string; type: string; where: string; implemented: boolean }>> = {};
const walk = (nodes: any[], model: string, where: string) => {
  for (const n of nodes ?? []) {
    if (n.kind === 'button' && n.name) {
      const type = n.type ?? 'object';
      // Odoo writes \ for a method and \ for an
      // action, but a few views carry other spellings, so a name that names a
      // method counts whatever the type says.
      const isMethod = Boolean(hooksFor(model).methods?.[n.name]);
      const isAction = Boolean(r.actions[n.name] || Object.values(r.actions).some((a: any) => a.xmlId === n.name));
      const implemented = type === 'action' ? isAction || isMethod : isMethod || isAction;
      (out[model] ??= {})[`${type}:${n.name}`] = { label: n.string?.en ?? n.label?.en ?? n.icon ?? '', type, where, implemented };
    }
    if (n.children) walk(n.children, model, where);
    if (n.pages) walk(n.pages, model, where);
    if (n.kind === 'field' && n.views) for (const [k, v] of Object.entries(n.views as any)) { const rel = r.models[model]?.fields[n.name]?.relation; if (rel && (v as any).body) walk((v as any).body, rel, `${where}>${n.name}`); }
  }
};
for (const [key, v] of Object.entries(r.views) as any) {
  if (v.arch.type === 'form') { walk(v.arch.header ?? [], v.model, `${key}:header`); walk(v.arch.body ?? [], v.model, `${key}:body`); }
  if (v.arch.type === 'list') walk(v.arch.headerButtons ?? [], v.model, `${key}:list-header`);
  if (v.arch.type === 'kanban') { walk(v.arch.templates ? Object.values(v.arch.templates).flat() as any[] : [], v.model, `${key}:kanban`); }
  // A view can carry a method of its own that a click on the record runs
  // (`<kanban action="…" type="object">` on the Sales Teams board); it is a
  // button in everything but the tag.
  if (v.arch.action) walk([{ kind: 'button', name: v.arch.action, type: v.arch.actionType ?? 'object', string: { en: `${v.arch.type} click` } }], v.model, `${key}:${v.arch.type}-click`);
}
let total = 0, done = 0;
const summary: string[] = [];
for (const [model, buttons] of Object.entries(out).sort()) {
  const list = Object.entries(buttons);
  total += list.length; done += list.filter(([, b]) => b.implemented).length;
  summary.push(`${model}: ${list.filter(([, b]) => !b.implemented).map(([k, b]) => `${k}(${b.label})`).join(', ')}`);
}
console.log(`buttons: ${total}, implemented: ${done}`);
console.log(summary.filter((s) => !s.endsWith(': ')).join('\n'));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
