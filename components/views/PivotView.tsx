'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PivotArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import type { ReadGroupRow } from '@engine/orm/read-group';
import type { I18n } from '@engine/i18n/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatValue, useCurrencies } from '@/lib/client/display';
import { Dropdown } from '../webclient/Navbar';
import { DATE_INTERVALS, groupField, groupKey, groupLabel, groupableFields, measureFields, withInterval } from './groups';
import { downloadCsv } from './export';

interface Props {
  arch: PivotArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  groupBy: string[];
  context: Record<string, unknown>;
  onDrill: (domain: Domain, title: string) => void;
}

interface HeaderNode { key: string; label: string; path: string[]; values: unknown[]; children: HeaderNode[]; domain: Domain; depth: number }

/**
 * Pivot view (A-4 §11): row and column group-bys with sub-totals at every
 * level, several measures, collapsible headers, flip axis, expand all,
 * click-through to the records and a CSV download. Every cell comes from
 * `read_group` (one query per row-depth × column-depth).
 */
export function PivotView({ arch, fields, model, domain, groupBy, context, onDrill }: Props) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const archRows = arch.fields.filter((f) => f.type === 'row').map((f) => withInterval(f.interval ? `${f.name}:${f.interval}` : f.name, fields));
  const archCols = arch.fields.filter((f) => f.type === 'col').map((f) => withInterval(f.interval ? `${f.name}:${f.interval}` : f.name, fields));
  const archMeasures = arch.fields.filter((f) => f.type === 'measure').map((f) => f.name);

  const [rowGroups, setRowGroups] = useState<string[]>(groupBy.length ? groupBy.map((g) => withInterval(g, fields)) : archRows);
  const [colGroups, setColGroups] = useState<string[]>(archCols);
  const [measures, setMeasures] = useState<string[]>(archMeasures.length ? archMeasures : ['__count']);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [cells, setCells] = useState<Map<string, ReadGroupRow>>(new Map());
  const [rowTree, setRowTree] = useState<HeaderNode[]>([]);
  const [colTree, setColTree] = useState<HeaderNode[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { if (groupBy.length) setRowGroups(groupBy.map((g) => withInterval(g, fields))); }, [groupBy]); // eslint-disable-line react-hooks/exhaustive-deps

  const measureSpecs = measures.map((m) => (m === '__count' ? '__count' : `${m}:sum`));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const map = new Map<string, ReadGroupRow>();
      const queries: Promise<void>[] = [];
      for (let r = 0; r <= rowGroups.length; r += 1) {
        for (let c = 0; c <= colGroups.length; c += 1) {
          const groups = [...rowGroups.slice(0, r), ...colGroups.slice(0, c)];
          queries.push(rpc<ReadGroupRow[]>('readGroup', model, { domain, fields: measureSpecs, groupby: groups, options: { lazy: false } }, { silent: true, context })
            .then((rows) => { for (const row of rows) map.set(cellKey(rowGroups.slice(0, r), colGroups.slice(0, c), row), row); })
            .catch(() => undefined));
        }
      }
      await Promise.all(queries);
      if (cancelled) return;
      setCells(map);
      setRowTree(buildTree(map, rowGroups, fields, t));
      setColTree(buildTree(map, colGroups, fields, t));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [model, JSON.stringify(domain), rowGroups.join(','), colGroups.join(','), measures.join(','), context]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalRow = cells.get(cellKey([], [], { __count: 0, __domain: [] }));
  const colLeaves = useMemo(() => leaves(colTree, collapsed), [colTree, collapsed]);
  const visibleRows = useMemo(() => flatten(rowTree, collapsed), [rowTree, collapsed]);
  const colDepth = colGroups.length;

  const cellValue = (rowNode: HeaderNode | null, colNode: HeaderNode | null, measure: string): unknown => {
    const rowSpec = rowNode ? rowGroups.slice(0, rowNode.depth) : [];
    const colSpec = colNode ? colGroups.slice(0, colNode.depth) : [];
    const key = [...rowSpec.map((g, i) => `${g}=${rowNode!.path[i]}`), ...colSpec.map((g, i) => `${g}=${colNode!.path[i]}`)].join('|');
    const row = cells.get(key);
    if (!row) return undefined;
    return measure === '__count' ? row.__count : row[measureField(measure)];
  };
  const format = (measure: string, value: unknown) => {
    if (value === undefined || value === null || value === false) return '';
    if (measure === '__count') return String(value);
    return formatValue(fields[measureField(measure)], value, { lang, record: {}, currencies });
  };
  const measureLabel = (measure: string) => (measure === '__count' ? t('Count') : t(fields[measureField(measure)]?.label ?? measure));

  const toggle = (node: HeaderNode) => setCollapsed((set) => { const next = new Set(set); if (next.has(node.key)) next.delete(node.key); else next.add(node.key); return next; });
  const addGroup = (axis: 'row' | 'col', spec: string) => {
    if (axis === 'row') setRowGroups((list) => [...list, spec]); else setColGroups((list) => [...list, spec]);
    setCollapsed(new Set());
  };
  const flip = () => { setRowGroups(colGroups); setColGroups(rowGroups); setCollapsed(new Set()); };
  const expandAll = () => setCollapsed(new Set());
  const toggleMeasure = (name: string) => setMeasures((list) => (list.includes(name) ? (list.length > 1 ? list.filter((m) => m !== name) : list) : [...list, name]));

  const download = () => {
    const header = [t('Total'), ...colLeaves.flatMap((col) => measures.map((m) => `${col.path.length ? col.label : t('Total')} / ${measureLabel(m)}`)), ...measures.map((m) => `${t('Total')} / ${measureLabel(m)}`)];
    const lines = visibleRows.map((row) => [
      `${'  '.repeat(row.depth - 1)}${row.label}`,
      ...colLeaves.flatMap((col) => measures.map((m) => format(m, cellValue(row, col.path.length ? col : null, m)))),
      ...measures.map((m) => format(m, cellValue(row, null, m))),
    ]);
    lines.push([t('Total'), ...colLeaves.flatMap((col) => measures.map((m) => format(m, cellValue(null, col.path.length ? col : null, m)))), ...measures.map((m) => format(m, cellValue(null, null, m)))]);
    downloadCsv(`${model}-pivot.csv`, [header, ...lines]);
  };

  const groupMenu = (axis: 'row' | 'col') => (
    <div style={{ maxHeight: 360, overflow: 'auto', minWidth: 220 }}>
      {groupableFields(fields).map((field) => (
        field.type === 'date' || field.type === 'datetime' ? (
          <div key={field.name} className="o_dropdown_item d-flex justify-content-between align-items-center" style={{ cursor: 'default' }}>
            <span>{t(field.label)}</span>
            <span className="d-flex gap-1">{DATE_INTERVALS.map((interval) => <button key={interval.key} type="button" className="btn btn-link btn-sm p-0 px-1" onClick={() => addGroup(axis, `${field.name}:${interval.key}`)}>{t(interval.label)}</button>)}</span>
          </div>
        ) : <button key={field.name} type="button" className="o_dropdown_item" onClick={() => addGroup(axis, field.name)}>{t(field.label)}</button>
      ))}
    </div>
  );

  const headerRows: HeaderNode[][] = [];
  for (let depth = 1; depth <= colDepth; depth += 1) headerRows.push(nodesAtDepth(colTree, collapsed, depth));
  const leafCount = (node: HeaderNode): number => (collapsed.has(node.key) || node.children.length === 0 ? 1 : node.children.reduce((sum: number, child) => sum + leafCount(child), 0));

  return (
    <div className="o_pivot_view">
      <div className="o_pivot_buttons d-flex gap-2 flex-wrap align-items-center mb-2">
        <Dropdown toggle={() => <button type="button" className="btn btn-secondary btn-sm">{t('Measures')} <i className="fa fa-caret-down" /></button>}>
          <div onClick={(event) => event.stopPropagation()}>
            {measureFields(fields).map((field) => (
              <button key={field.name} type="button" className="o_dropdown_item" onClick={() => toggleMeasure(field.name)}><span style={{ display: 'inline-block', width: 16 }}>{measures.includes(field.name) ? '✓' : ''}</span>{t(field.label)}</button>
            ))}
            <div className="o_dropdown_divider" />
            <button type="button" className="o_dropdown_item" onClick={() => toggleMeasure('__count')}><span style={{ display: 'inline-block', width: 16 }}>{measures.includes('__count') ? '✓' : ''}</span>{t('Count')}</button>
          </div>
        </Dropdown>
        <button type="button" className="btn btn-secondary btn-sm" onClick={flip} title={t('Flip axis')}><i className="fa fa-exchange" /></button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={expandAll} title={t('Expand all')}><i className="fa fa-arrows" /></button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download} title={t('Download xlsx')}><i className="fa fa-download" /></button>
        {(rowGroups.length > 0 || colGroups.length > 0) && (
          <button type="button" className="btn btn-link btn-sm text-muted" onClick={() => { setRowGroups([]); setColGroups([]); setCollapsed(new Set()); }}>{t('Reset')}</button>
        )}
      </div>
      {loading && <div className="o_loading_indicator" />}
      <div className="o_pivot_scroll" style={{ overflow: 'auto' }}>
        <table className="o_pivot_table table table-sm table-bordered mb-0">
          <thead>
            {(headerRows.length ? headerRows : [[]]).map((nodes, level) => (
              <tr key={level}>
                {level === 0 && (
                  <th rowSpan={Math.max(1, colDepth) + (measures.length > 1 || colDepth > 0 ? 1 : 0)} className="o_pivot_origin" style={{ verticalAlign: 'bottom' }}>
                    <Dropdown toggle={() => <span className="o_pivot_header_cell_closed text-muted" style={{ cursor: 'pointer' }}>{rowGroups.map((g) => t(fields[groupField(g)]?.label ?? g)).join(' › ') || t('Total')} <i className="fa fa-caret-down" /></span>}>{groupMenu('row')}</Dropdown>
                  </th>
                )}
                {level === 0 && colDepth === 0 && (
                  <th colSpan={measures.length} className="text-center">
                    <Dropdown toggle={() => <span style={{ cursor: 'pointer' }}>{t('Total')} <i className="fa fa-caret-down" /></span>}>{groupMenu('col')}</Dropdown>
                  </th>
                )}
                {nodes.map((node) => (
                  <th key={node.key} colSpan={leafCount(node) * measures.length} className="text-center o_pivot_header_cell" style={{ cursor: 'pointer' }} onClick={() => toggle(node)}>
                    <i className={`fa ${collapsed.has(node.key) || node.children.length === 0 ? 'fa-caret-right' : 'fa-caret-down'} me-1 text-muted`} />{node.label}
                  </th>
                ))}
                {level === 0 && colDepth > 0 && <th rowSpan={colDepth} colSpan={measures.length} className="text-center">{t('Total')}</th>}
              </tr>
            ))}
            {(measures.length > 1 || (colDepth > 0)) && (
              <tr>
                {colLeaves.map((leaf) => measures.map((m) => <th key={`${leaf.key}:${m}`} className="text-end small text-muted fw-normal">{measureLabel(m)}</th>))}
                {measures.map((m) => <th key={`total:${m}`} className="text-end small text-muted fw-normal">{measureLabel(m)}</th>)}
              </tr>
            )}
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.key} className={row.depth === 1 ? 'fw-bold' : ''}>
                <th className="o_pivot_header_cell" style={{ paddingInlineStart: 8 + (row.depth - 1) * 20, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {row.children.length > 0 || row.depth < rowGroups.length ? (
                    <span onClick={() => toggle(row)}><i className={`fa ${collapsed.has(row.key) || row.children.length === 0 ? 'fa-caret-right' : 'fa-caret-down'} me-1 text-muted`} />{row.label}</span>
                  ) : (
                    <Dropdown toggle={() => <span><i className="fa fa-caret-right me-1 text-muted" />{row.label}</span>}>{groupMenu('row')}</Dropdown>
                  )}
                </th>
                {colLeaves.map((leaf) => measures.map((m) => {
                  const value = cellValue(row, leaf.path.length ? leaf : null, m);
                  return <td key={`${leaf.key}:${m}`} className="o_pivot_cell_value text-end" style={{ cursor: value !== undefined ? 'pointer' : 'default' }} onClick={() => value !== undefined && onDrill(joinDomains(domain, row.domain, leaf.domain), `${row.label}${leaf.path.length ? ` / ${leaf.label}` : ''}`)}>{format(m, value)}</td>;
                }))}
                {measures.map((m) => <td key={`total:${m}`} className="o_pivot_cell_value text-end fw-bold" style={{ cursor: 'pointer' }} onClick={() => onDrill(joinDomains(domain, row.domain), row.label)}>{format(m, cellValue(row, null, m))}</td>)}
              </tr>
            ))}
            <tr className="o_pivot_total fw-bold">
              <th>{t('Total')}</th>
              {colLeaves.map((leaf) => measures.map((m) => <td key={`${leaf.key}:${m}`} className="text-end" style={{ cursor: 'pointer' }} onClick={() => onDrill(joinDomains(domain, leaf.domain), leaf.label)}>{format(m, cellValue(null, leaf.path.length ? leaf : null, m))}</td>))}
              {measures.map((m) => <td key={`total:${m}`} className="text-end" style={{ cursor: 'pointer' }} onClick={() => onDrill(domain, t('Total'))}>{format(m, totalRow ? (m === '__count' ? totalRow.__count : totalRow[measureField(m)]) : undefined)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function measureField(measure: string): string { return measure.split(':')[0]; }

function cellKey(rowSpec: string[], colSpec: string[], row: ReadGroupRow): string {
  return [...rowSpec, ...colSpec].map((g) => `${g}=${groupKey(row, g)}`).join('|');
}

/** Build the header tree for one axis from the deepest query on that axis alone. */
function buildTree(cells: Map<string, ReadGroupRow>, groups: string[], fields: Record<string, FieldDef>, t: (text: I18n | string | undefined) => string): HeaderNode[] {
  const roots: HeaderNode[] = [];
  const index = new Map<string, HeaderNode>();
  for (let depth = 1; depth <= groups.length; depth += 1) {
    const spec = groups.slice(0, depth);
    for (const [key, row] of cells) {
      const parts = key ? key.split('|') : [];
      if (parts.length !== depth || !spec.every((g, i) => parts[i].startsWith(`${g}=`))) continue;
      const path = parts.map((part) => part.slice(part.indexOf('=') + 1));
      const parentKey = parts.slice(0, -1).join('|');
      const node: HeaderNode = {
        key, path, depth, values: [], children: [],
        label: groupLabel(row, groups[depth - 1], fields[groupField(groups[depth - 1])], t),
        domain: row.__domain,
      };
      index.set(key, node);
      if (depth === 1) roots.push(node); else index.get(parentKey)?.children.push(node);
    }
  }
  return roots;
}

function flatten(nodes: HeaderNode[], collapsed: Set<string>): HeaderNode[] {
  const out: HeaderNode[] = [];
  const visit = (node: HeaderNode) => { out.push(node); if (!collapsed.has(node.key)) node.children.forEach(visit); };
  nodes.forEach(visit);
  return out;
}

function leaves(nodes: HeaderNode[], collapsed: Set<string>): HeaderNode[] {
  if (nodes.length === 0) return [{ key: 'total', label: '', path: [], values: [], children: [], domain: [], depth: 0 }];
  const out: HeaderNode[] = [];
  const visit = (node: HeaderNode) => { if (collapsed.has(node.key) || node.children.length === 0) out.push(node); else node.children.forEach(visit); };
  nodes.forEach(visit);
  return out;
}

function nodesAtDepth(nodes: HeaderNode[], collapsed: Set<string>, depth: number): HeaderNode[] {
  const out: HeaderNode[] = [];
  const visit = (node: HeaderNode) => {
    if (node.depth === depth) { out.push(node); return; }
    if (!collapsed.has(node.key)) node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function joinDomains(...domains: Domain[]): Domain {
  const parts = domains.filter((d) => d.length);
  if (parts.length <= 1) return parts[0] ?? [];
  return [...Array(parts.length - 1).fill('&'), ...parts.flat()] as Domain;
}
