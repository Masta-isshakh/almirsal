'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ButtonNode, FieldNode, FormArch, FormNode, GroupNode } from '@engine/registry/arch';
import type { FieldDef, ViewDef, ViewType } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formFields, isInvisible, isReadonly, isRequired, makeRecordScope, specificationFor } from '@/lib/client/arch';
import { formatValue, idOf, nameOf, useCurrencies } from '@/lib/client/display';
import { Field } from '../fields/Field';
import { Chatter } from '../webclient/Chatter';
import { useUi } from '../webclient/ui';
import type { SessionInfo } from '../webclient/WebClient';

type Rec = Record<string, unknown>;

interface Props {
  arch: FormArch;
  fields: Record<string, FieldDef>;
  model: string;
  recordId: number | null;
  context: Record<string, unknown>;
  user: SessionInfo;
  slug: string;
  views: Partial<Record<ViewType, ViewDef>>;
}

/**
 * A-4 §5: always-editable form with sticky status bar (buttons + stage
 * pipeline), sheet, smart buttons, groups, notebook, embedded lines, and
 * the chatter. Saves through `web_save`; button clicks go through
 * `call_button` and reload the record.
 */
export function FormView({ arch, fields, model, recordId, context, user, slug }: Props) {
  const t = useT();
  const router = useRouter();
  const ui = useUi();
  const [record, setRecord] = useState<Rec | null>(null);
  const [changes, setChanges] = useState<Rec>({});
  const [saving, setSaving] = useState(false);
  const nodes = useMemo(() => formFields(arch), [arch]);
  const names = useMemo(() => [...new Set(nodes.map((node) => node.name).filter((name) => fields[name]))], [nodes, fields]);
  const spec = useMemo(() => specificationFor(names, fields, nodes), [names, fields, nodes]);

  const load = useCallback(async () => {
    if (recordId) {
      const [loaded] = await rpc<Rec[]>('webRead', model, { ids: [recordId], specification: spec });
      setRecord(loaded ?? null);
    } else {
      const defaults = await rpc<Rec>('defaultGet', model, { fields: names });
      const initial: Rec = { id: false };
      for (const name of names) initial[name] = defaults[name] ?? (fields[name].type === 'one2many' || fields[name].type === 'many2many' ? [] : false);
      // Resolve many2one defaults to {id, display_name}.
      for (const name of names) {
        const field = fields[name];
        if (field.type === 'many2one' && typeof initial[name] === 'number') {
          const found = await rpc<[number, string][]>('nameSearch', field.relation!, { domain: [['id', '=', initial[name]]], limit: 1 }, { silent: true }).catch(() => []);
          initial[name] = found[0] ? { id: found[0][0], display_name: found[0][1] } : false;
        }
      }
      setRecord(initial);
    }
    setChanges({});
  }, [recordId, model, spec, names, fields]);

  useEffect(() => { load().catch(() => undefined); }, [load]);

  const values = useMemo<Rec>(() => ({ ...(record ?? {}), ...changes }), [record, changes]);
  const scope = useMemo(() => makeRecordScope(values, { uid: user.uid, context, companyIds: user.companyIds }), [values, user, context]);
  const dirty = Object.keys(changes).length > 0;

  useEffect(() => {
    const title = document.getElementById('o_breadcrumb_current');
    if (title && record) title.textContent = recordId ? String(values.display_name ?? values.name ?? '') : t('New');
  }, [record, values, recordId, t]);

  const setValue = (name: string, value: unknown) => setChanges((current) => ({ ...current, [name]: value }));

  /** Wire values → write values (many2one objects → ids, tags → replace command). */
  const writeValues = (): Rec => {
    const out: Rec = {};
    for (const [name, value] of Object.entries(changes)) {
      const field = fields[name];
      if (!field) continue;
      if (field.type === 'many2one') out[name] = idOf(value) ?? false;
      else if (field.type === 'many2many') out[name] = [[6, 0, (value as unknown[]).map((item) => idOf(item)).filter((id): id is number => id !== null)]];
      else if (field.type === 'one2many') continue;
      else out[name] = value;
    }
    return out;
  };

  const save = async (): Promise<number | null> => {
    if (!dirty && recordId) return recordId;
    setSaving(true);
    try {
      const saved = await rpc<Rec>('webSave', model, { id: recordId ?? undefined, values: writeValues(), specification: spec });
      setRecord(saved);
      setChanges({});
      if (!recordId) router.replace(`/odoo/${slug}/${saved.id}`);
      return saved.id as number;
    } catch {
      return null;
    } finally {
      setSaving(false);
    }
  };

  const discard = () => { if (recordId) setChanges({}); else router.push(`/odoo/${slug}`); };

  const clickButton = async (button: ButtonNode) => {
    if (button.confirm && !(await ui.confirm({ message: button.confirm }))) return;
    const id = await save();
    if (!id) return;
    if (button.type === 'object' && button.name) {
      try {
        const result = await rpc<Rec | false>('callButton', model, { ids: [id], method: button.name, context });
        if (result && typeof result === 'object' && result.type === 'ir.actions.client' && result.tag === 'display_notification') {
          const params = (result.params ?? {}) as { title?: string; message?: string; type?: 'success' | 'warning' | 'danger' | 'info' };
          ui.notify({ title: params.title, message: params.message ?? '', type: params.type ?? 'info' });
        }
        await load();
      } catch { /* dialog already shown */ }
    } else if (button.type === 'action' && button.name) {
      router.push(`/odoo/action-${button.name}?active_id=${id}`);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      if (event.altKey && event.key.toLowerCase() === 'j') { event.preventDefault(); discard(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!record) return <div className="o_loading_indicator" />;

  const header = arch.body.find((node): node is Extract<FormNode, { kind: 'header' }> => node.kind === 'header');
  const hasChatter = arch.body.some((node) => node.kind === 'chatter');
  const ctx = { values, fields, scope, setValue, clickButton, readonlyAll: false };

  return (
    <div className="o_form_view">
      <div className="o_form_statusbar">
        <div className="o_statusbar_buttons">
          {header?.children.filter((node): node is ButtonNode => node.kind === 'button').filter((button) => !isInvisible(button, scope)).map((button, index) => (
            <button key={index} type="button" className={`btn ${/btn-primary|oe_highlight/.test(button.class ?? '') ? 'btn-primary' : 'btn-secondary'}`} onClick={() => clickButton(button)} title={t(button.help)}>
              {button.icon && <i className={`${button.icon.startsWith('fa') ? 'fa ' : ''}${button.icon} me-1`} />}{t(button.string)}
            </button>
          ))}
        </div>
        <div className="o_form_buttons_edit ms-auto">
          <span className="o_form_status_indicator">
            {saving ? <i className="fa fa-spinner fa-spin" /> : dirty ? <i className="fa fa-cloud-upload o_form_dirty" title={t('Unsaved changes')} /> : <i className="fa fa-cloud text-muted" />}
            {(dirty || !recordId) && (
              <>
                <button type="button" className="btn btn-sm btn-link" onClick={() => void save()} title="Alt+S"><i className="fa fa-check" /></button>
                <button type="button" className="btn btn-sm btn-link text-muted" onClick={discard} title="Alt+J"><i className="fa fa-times" /></button>
              </>
            )}
          </span>
        </div>
        {header?.children.filter((node): node is FieldNode => node.kind === 'field' && node.widget === 'statusbar').map((node) => (
          <StatusBar key={node.name} node={node} field={fields[node.name]} value={values[node.name]} />
        ))}
      </div>
      <div className={hasChatter ? 'o_form_renderer_with_chatter' : ''}>
        <div className="o_form_sheet_bg">
          {arch.body.filter((node) => node.kind !== 'header' && node.kind !== 'chatter').map((node, index) => <Node key={index} node={node} ctx={ctx} />)}
        </div>
        {hasChatter && recordId && <Chatter model={model} recordId={recordId} user={user} />}
      </div>
    </div>
  );
}

interface RenderCtx {
  values: Rec;
  fields: Record<string, FieldDef>;
  scope: ReturnType<typeof makeRecordScope>;
  setValue: (name: string, value: unknown) => void;
  clickButton: (button: ButtonNode) => void;
  readonlyAll: boolean;
}

function Node({ node, ctx }: { node: FormNode; ctx: RenderCtx }): ReactNode {
  const t = useT();
  const { scope } = ctx;
  switch (node.kind) {
    case 'sheet':
      return <div className="o_form_sheet">{node.children.map((child, index) => <Node key={index} node={child} ctx={ctx} />)}</div>;
    case 'buttonbox': {
      const buttons = node.children.filter((child): child is ButtonNode => child.kind === 'button').filter((button) => !isInvisible(button, scope));
      if (buttons.length === 0) return null;
      return (
        <div className="oe_button_box">
          {buttons.map((button, index) => (
            <button key={index} type="button" className="oe_stat_button" onClick={() => ctx.clickButton(button)}>
              {button.icon && <i className={`fa ${button.icon}`} />}
              <span>{button.string ? t(button.string) : ''}</span>
            </button>
          ))}
        </div>
      );
    }
    case 'element': {
      if (isInvisible(node, scope)) return null;
      const classes = node.class ?? '';
      const children = <>{node.text && t(node.text)}{node.children.map((child, index) => <Node key={index} node={child} ctx={ctx} />)}</>;
      if (classes.includes('oe_title')) return <div className="oe_title">{children}</div>;
      if (classes.includes('oe_subtotal_footer')) return <div className="oe_subtotal_footer">{children}</div>;
      if (node.tag === 'h1') return <h1>{children}</h1>;
      if (node.tag === 'h2') return <h2 className="fs-5 fw-normal">{children}</h2>;
      if (node.tag === 'h3') return <h3 className="fs-6">{children}</h3>;
      if (node.tag === 'strong' || node.tag === 'b') return <strong className={classes}>{children}</strong>;
      if (node.tag === 'i' || node.tag === 'em') return <em className={classes}>{children}</em>;
      if (node.tag === 'small') return <small className={classes}>{children}</small>;
      if (node.tag === 'span' || node.tag === 'a' || node.tag === 'label') return <span className={classes}>{children}</span>;
      if (node.tag === 'p') return <p className={classes}>{children}</p>;
      if (node.tag === 'footer' || node.tag === 'link' || node.tag === 't') return <div className={classes}>{children}</div>;
      return <div className={classes}>{children}</div>;
    }
    case 'group': return <Group node={node} ctx={ctx} />;
    case 'notebook': return <Notebook pages={node.pages} ctx={ctx} />;
    case 'page': return <>{node.children.map((child, index) => <Node key={index} node={child} ctx={ctx} />)}</>;
    case 'separator':
      return isInvisible(node, scope) ? null : <div className="o_form_separator">{t(node.string)}</div>;
    case 'label':
      return isInvisible(node, scope) ? null : <label className={`o_form_label ${node.class ?? ''}`}>{t(node.string ?? ctx.fields[node.for ?? '']?.label)}</label>;
    case 'button':
      return isInvisible(node, scope) ? null : (
        <button type="button" className={`btn ${/btn-primary/.test(node.class ?? '') ? 'btn-primary' : /btn-link/.test(node.class ?? '') ? 'btn-link' : 'btn-secondary'} btn-sm`} onClick={() => ctx.clickButton(node)}>
          {node.icon && <i className={`fa ${node.icon} me-1`} />}{t(node.string)}
        </button>
      );
    case 'field': return <FieldSlot node={node} ctx={ctx} withLabel={false} />;
    case 'widget':
      if (node.name === 'web_ribbon') return isInvisible(node, scope) ? null : <div className="position-absolute top-0 end-0 m-2 badge text-bg-warning">{t(node.title)}</div>;
      return null;
    case 'app': case 'block': case 'setting': case 'create':
      return <div>{'children' in node ? node.children.map((child, index) => <Node key={index} node={child} ctx={ctx} />) : null}</div>;
    default:
      return null;
  }
}

/** Odoo's `<group>`: an outer 2-column grid when it holds groups, else label/field rows. */
function Group({ node, ctx }: { node: GroupNode; ctx: RenderCtx }) {
  const t = useT();
  if (isInvisible(node, ctx.scope)) return null;
  const hasSubGroups = node.children.some((child) => child.kind === 'group');
  if (hasSubGroups) {
    return (
      <div className={`o_group ${(node.col ?? 2) === 1 ? 'o_group_single' : ''}`}>
        {node.string && <h2 className="fs-5" style={{ gridColumn: '1 / -1' }}>{t(node.string)}</h2>}
        {node.children.map((child, index) => (
          child.kind === 'group' ? <Node key={index} node={child} ctx={ctx} /> : <div key={index} style={{ gridColumn: '1 / -1' }}><Node node={child} ctx={ctx} /></div>
        ))}
      </div>
    );
  }
  return (
    <div className="o_inner_group">
      {node.string && <h2>{t(node.string)}</h2>}
      {node.children.map((child, index) => (
        child.kind === 'field' ? <FieldSlot key={index} node={child} ctx={ctx} withLabel />
          : <div key={index} style={{ gridColumn: '1 / -1' }}><Node node={child} ctx={ctx} /></div>
      ))}
    </div>
  );
}

function FieldSlot({ node, ctx, withLabel }: { node: FieldNode; ctx: RenderCtx; withLabel: boolean }) {
  const t = useT();
  const field = ctx.fields[node.name];
  if (!field || node.hidden) return null;
  if (isInvisible(node, ctx.scope)) return null;
  const readonly = ctx.readonlyAll || isReadonly(node, field, ctx.scope);
  const required = isRequired(node, field, ctx.scope);
  const isLines = field.type === 'one2many' || (field.type === 'many2many' && node.views?.list);
  const control = isLines
    ? <EmbeddedList node={node} field={field} value={ctx.values[node.name]} />
    : <Field node={node} field={field} value={ctx.values[node.name]} record={ctx.values} readonly={readonly} required={required} onChange={(value) => ctx.setValue(node.name, value)} />;
  if (!withLabel || node.nolabel) return isLines ? <div style={{ gridColumn: '1 / -1' }}>{control}</div> : control;
  return (
    <>
      <label className={`o_form_label ${required ? 'o_field_required' : ''}`} title={t(node.help ?? field.help)}>{t(node.string ?? field.label)}</label>
      {control}
    </>
  );
}

function Notebook({ pages, ctx }: { pages: Extract<FormNode, { kind: 'page' }>[]; ctx: RenderCtx }) {
  const t = useT();
  const visible = pages.filter((page) => !isInvisible(page, ctx.scope));
  const [active, setActive] = useState(0);
  const current = visible[Math.min(active, visible.length - 1)];
  if (!current) return null;
  return (
    <div className="o_notebook">
      <div className="o_notebook_headers">
        {visible.map((page, index) => (
          <button key={page.name ?? index} type="button" className={`nav-link ${page === current ? 'active' : ''}`} onClick={() => setActive(index)}>{t(page.string)}</button>
        ))}
      </div>
      <div className="o_notebook_content"><Node node={current} ctx={ctx} /></div>
    </div>
  );
}

function StatusBar({ node, field, value }: { node: FieldNode; field: FieldDef | undefined; value: unknown }) {
  const t = useT();
  if (!field?.selection) return null;
  const visible = node.statusbarVisible ? node.statusbarVisible.split(',').map((item) => item.trim()) : field.selection.map((option) => option.value);
  const options = field.selection.filter((option) => visible.includes(option.value) || option.value === value);
  return (
    <div className="o_statusbar_status">
      {options.map((option) => (
        <button key={option.value} type="button" className={`o_arrow_button ${option.value === value ? 'o_arrow_button_current' : ''}`}><span>{t(option.label)}</span></button>
      ))}
    </div>
  );
}

/** Embedded one2many/many2many list (read-only lines for now). */
function EmbeddedList({ node, field, value }: { node: FieldNode; field: FieldDef; value: unknown }) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const embedded = node.views?.list;
  const rows = Array.isArray(value) ? (value as Rec[]) : [];
  const columns = embedded && embedded.type === 'list'
    ? embedded.columns.filter((column): column is FieldNode => column.kind === 'field' && !column.hidden && column.columnInvisible !== true && column.optional !== 'hide' && column.widget !== 'handle')
    : [];
  if (!embedded || columns.length === 0) {
    return <div className="o_field_widget o_readonly text-muted">{rows.map((row) => nameOf(row) || String(row.id)).join(', ') || t('None')}</div>;
  }
  const isSection = (row: Rec) => typeof row.display_type === 'string' && row.display_type.startsWith('line_');
  const listArch = embedded.type === 'list' ? embedded : null;
  const controls = listArch?.control.filter((c): c is Extract<FormNode, { kind: 'create' }> => c.kind === 'create') ?? [];
  const addLinks = controls.length ? controls : [{ kind: 'create' as const, string: { en: 'Add a line', ar: 'إضافة بند' } }];
  return (
    <div className="o_embedded_list">
      <table className="o_list_table">
        <thead><tr>{columns.map((column) => <th key={column.name}>{t(column.string ?? column.name)}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            isSection(row)
              ? <tr key={String(row.id)}><td colSpan={columns.length} className={row.display_type === 'line_note' ? 'fst-italic text-muted' : 'fw-bold'}>{String(row.name ?? '')}</td></tr>
              : (
                <tr key={String(row.id)}>
                  {columns.map((column) => {
                    const cell = row[column.name];
                    const text = Array.isArray(cell) && cell.length === 2 && typeof cell[1] === 'string' ? cell[1]
                      : typeof cell === 'number' ? (column.widget === 'monetary' ? formatValue({ ...field, type: 'monetary', name: column.name, label: field.label }, cell, { lang, record: row, currencies }) : String(cell))
                      : cell === false || cell == null ? '' : String(cell);
                    return <td key={column.name} className={typeof cell === 'number' ? 'o_list_number' : ''}>{text}</td>;
                  })}
                </tr>
              )
          ))}
          {rows.length === 0 && <tr><td colSpan={columns.length} className="text-muted">{t('No lines')}</td></tr>}
        </tbody>
      </table>
      <div className="o_list_add">
        {addLinks.map((control, index) => (
          <a key={index} href="#add" onClick={(event) => event.preventDefault()}>{t(control.string)}</a>
        ))}
      </div>
    </div>
  );
}
