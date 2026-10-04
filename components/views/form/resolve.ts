import type { FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';

type Rec = Record<string, unknown>;

/**
 * Server values (defaults, onchange results) → the shape the field widgets
 * draw: a many2one id becomes `{ id, display_name }`, a many2many command
 * list the records it names.
 */
export async function resolveWireValues(fields: Record<string, FieldDef>, incoming: Rec): Promise<Rec> {
  const out: Rec = {};
  for (const [key, value] of Object.entries(incoming)) {
    const def = fields[key];
    if (def?.type === 'many2one' && typeof value === 'number') {
      const found = await rpc<[number, string][]>('nameSearch', def.relation!, { domain: [['id', '=', value]], limit: 1 }, { silent: true }).catch(() => []);
      out[key] = found[0] ? { id: found[0][0], display_name: found[0][1] } : false;
    } else if (def?.type === 'many2many' && Array.isArray(value) && Array.isArray(value[0])) {
      const ids = (value[0] as [number, number, number[]])[2] ?? [];
      out[key] = ids.length ? await rpc<Rec[]>('read', def.relation!, { ids, fields: ['display_name'] }, { silent: true }).catch(() => []) : [];
    } else {
      out[key] = value;
    }
  }
  return out;
}
