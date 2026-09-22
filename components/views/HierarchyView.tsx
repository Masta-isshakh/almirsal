'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HierarchyArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';
import { useUi } from '../webclient/ui';

type Rec = Record<string, unknown>;

interface Props {
  arch: HierarchyArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  context: Record<string, unknown>;
  onOpen: (id: number) => void;
}

interface Node { id: number; record: Rec; children: Node[] }

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}
function hue(name: string): number { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }

/**
 * Hierarchy view (A-4 §17, org chart / departments / articles): a tree of
 * cards built from the `parent_field` (default `parent_id`) — roots on top,
 * children under a caret that expands or collapses the branch; the card
 * shows the record name, the first text fields of the arch and an avatar
 * with the record's initials. Drag a card onto another one to re-parent
 * when `draggable` is set; click a card to open the form.
 */
export function HierarchyView({ arch, fields, model, domain, context, onOpen }: Props) {
  const t = useT();
  const ui = useUi();
  const parentField = arch.parentField && fields[arch.parentField] ? arch.parentField : fields.parent_id ? 'parent_id' : null;
  const [records, setRecords] = useState<Rec[]>([]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = useMemo(() => arch.fields.map((f) => f.name).filter((name, index, list) => fields[name] && list.indexOf(name) === index && !['id', 'sequence', 'color', 'department_color', 'hr_icon_display', 'image_1024', 'image_128', 'is_user_favorite', 'category', 'display_name', 'name'].includes(name) && !['binary', 'image', 'one2many', 'many2many', 'html'].includes(fields[name].type)).slice(0, 4), [arch.fields, fields]);

  const load = useCallback(async () => {
    setLoading(true);
    const names = [...new Set(['display_name', ...(parentField ? [parentField] : []), ...shown, ...(fields.name ? ['name'] : [])])];
    const rows = await rpc<Rec[]>('searchRead', model, { domain, fields: names, limit: 2000 }, { silent: true, context }).catch(() => [] as Rec[]);
    setRecords(rows);
    setOpen((current) => (current.size ? current : new Set(rows.filter((r) => !parentField || !idOf(r[parentField])).map((r) => r.id as number))));
    setLoading(false);
  }, [model, JSON.stringify(domain), context, parentField, shown.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const tree = useMemo<Node[]>(() => {
    const byId = new Map<number, Node>(records.map((r) => [r.id as number, { id: r.id as number, record: r, children: [] }]));
    const roots: Node[] = [];
    for (const node of byId.values()) {
      const parent = parentField ? idOf(node.record[parentField]) : null;
      if (parent && byId.has(parent)) byId.get(parent)!.children.push(node); else roots.push(node);
    }
    const sort = (nodes: Node[]) => { nodes.sort((a, b) => String(a.record.display_name ?? '').localeCompare(String(b.record.display_name ?? ''))); nodes.forEach((n) => sort(n.children)); };
    sort(roots);
    return roots;
  }, [records, parentField]);

  const toggle = (id: number) => setOpen((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const reparent = async (child: number, parent: number | null) => {
    if (!parentField || child === parent) return;
    try { await rpc('write', model, { ids: [child], values: { [parentField]: parent } }, { context }); await load(); }
    catch (error) { ui.notify({ type: 'danger', message: String((error as Error).message ?? error) }); }
  };
  const draggable = Boolean(arch.draggable && parentField);

  const Card = ({ node, depth }: { node: Node; depth: number }) => {
    const name = String(node.record.display_name ?? node.record.name ?? '');
    const expanded = open.has(node.id);
    return (
      <div className="o_hierarchy_node">
        <div className={`o_hierarchy_card ${dragging === node.id ? 'opacity-50' : ''}`} draggable={draggable}
          onDragStart={(event) => { setDragging(node.id); event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => setDragging(null)}
          onDragOver={(event) => { if (draggable && dragging !== null && dragging !== node.id) event.preventDefault(); }}
          onDrop={(event) => { event.preventDefault(); if (dragging !== null) void reparent(dragging, node.id); setDragging(null); }}
          onClick={() => onOpen(node.id)}>
          <div className="o_hierarchy_avatar" style={{ background: `hsl(${hue(name)}, 68%, 52%)` }}>{initials(name) || '?'}</div>
          <div className="o_hierarchy_body">
            <div className="fw-bold text-truncate" title={name}>{name}</div>
            {shown.map((f) => {
              const value = node.record[f];
              if (value === false || value === null || value === undefined || value === '') return null;
              return <div key={f} className="small text-muted text-truncate">{Array.isArray(value) ? nameOf(value) || (value as unknown[]).map((v) => nameOf(v) || String(v)).join(', ') : String(value)}</div>;
            })}
          </div>
          {node.children.length > 0 && (
            <button type="button" className="o_hierarchy_toggle" title={expanded ? t('Collapse') : t('Expand')} onClick={(event) => { event.stopPropagation(); toggle(node.id); }}>
              <i className={`fa fa-caret-${expanded ? 'up' : 'down'}`} /> {node.children.length}
            </button>
          )}
        </div>
        {expanded && node.children.length > 0 && (
          <div className="o_hierarchy_children" style={{ ['--depth' as string]: depth + 1 }}>
            {node.children.map((child) => <Card key={child.id} node={child} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="o_hierarchy_view">
      <div className="d-flex align-items-center gap-2 mb-2">
        <button type="button" className="btn btn-link btn-sm" onClick={() => setOpen(new Set(records.map((r) => r.id as number)))}><i className="fa fa-expand me-1" />{t('Expand all')}</button>
        <button type="button" className="btn btn-link btn-sm" onClick={() => setOpen(new Set())}><i className="fa fa-compress me-1" />{t('Collapse all')}</button>
        {draggable && <span className="text-muted small ms-auto"><i className="fa fa-arrows me-1" />{t('Drag a card onto another to move it under it.')}</span>}
      </div>
      {loading && <div className="o_loading_indicator" />}
      {!loading && tree.length === 0 && <div className="p-5 text-center text-muted"><i className="fa fa-sitemap fa-2x d-block mb-2 opacity-50" />{t('No records to display')}</div>}
      <div className="o_hierarchy_roots" onDragOver={(event) => { if (draggable && dragging !== null) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragging !== null) void reparent(dragging, null); setDragging(null); }}>
        {tree.map((node) => <Card key={node.id} node={node} depth={0} />)}
      </div>
    </div>
  );
}
