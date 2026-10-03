import { readFileSync, writeFileSync } from 'node:fs';
import { loadRegistry } from '../packages/engine/registry/spec-loader.js';
const spec = JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8'));
const extra = JSON.parse(readFileSync('registry/extra-models.json', 'utf8'));
const r = loadRegistry(spec, extra);
const menus: any[] = [];
const walk = (nodes: any[], app: string | null, depth: number) => { for (const n of nodes ?? []) { menus.push({ app: app ?? n.name?.en, name: n.name?.en, action: n.action ?? n.actionId ?? null, depth }); walk(n.children ?? [], app ?? n.name?.en, depth + 1); } };
walk(r.menus as any, null, 0);
const actions = Object.values(r.actions).map((a: any) => ({ id: a.id, xmlId: a.xmlId, path: a.path, type: a.type, model: a.model, viewMode: a.viewMode, views: a.views, name: a.name?.en, target: a.target }));
// The form architectures too: a fidelity check compares what a view
// declares with what the screen shows.
const views = Object.values(r.views).filter((v: any) => v.type === 'form' || v.type === 'list').map((v: any) => ({ key: v.key, id: v.id, model: v.model, type: v.type, arch: v.arch }));
writeFileSync(process.argv[2], JSON.stringify({ menusCount: menus.length, menus, actions, models: Object.keys(r.models).length, views }), 'utf8');
console.log('menus', menus.length, 'actions', actions.length, 'models', Object.keys(r.models).length, 'views', Object.keys(r.views).length);
console.log(JSON.stringify(r.menus[0]).slice(0, 600));
