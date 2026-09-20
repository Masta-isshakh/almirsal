'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ButtonNode, FieldNode, FormArch, FormNode, GroupNode } from '@engine/registry/arch';
import type { FieldDef } from '@engine/registry/types';
import { evaluate } from '@engine/expr/evaluate';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { useActions } from '@/lib/client/actions';
import { RECORD_CACHE_MS, formSpecification, isInvisible, isReadonly, isRequired, makeRecordScope } from '@/lib/client/arch';
import { idOf, nameOf } from '@/lib/client/display';
import { Field } from '../fields/Field';
import { Chatter } from '../webclient/Chatter';
import { SettingsPage } from './form/Settings';
import { useUi } from '../webclient/ui';
import type { SessionInfo } from '../webclient/WebClient';
import { EmbeddedList } from './form/EmbeddedList';
import { FormSkeleton } from './Skeleton';
import { useNavigation } from '@/lib/client/navigation';
import { hasLineChanges, rowsFromRecords, toCommands, type LineRow, type Rec } from './form/lines';

interface Props {
  arch: FormArch;
  fields: Record<string, FieldDef>;
  relatedFields?: Record<string, Record<string, FieldDef>>;
  model: string;
  recordId: number | null;
  context: Record<string, unknown>;
  user: SessionInfo;
  slug: string;
  /** `dialog` = wizard: no status bar/chatter, footer buttons from the arch. */
  mode?: 'page' | 'dialog';
  onDone?: (changed: boolean) => void;
}

/**
 * A-4 §5: always-editable form — sticky status bar (header buttons + stage
 * pipeline), sheet, smart buttons, groups, notebook, editable x2many lines,
 * chatter, keyboard save/discard. Saves through `web_save`; buttons run
 * through `call_button` and the action runner.
 */
export function FormView({ arch, fields, relatedFields = {}, model, recordId, context, user, slug, mode = 'page', onDone }: Props) {
  const t = useT();
  const { navigate } = useNavigation();
  const ui = useUi();
  const { doAction } = useActions();
  const [record, setRecord] = useState<Rec | null>(null);
  const [changes, setChanges] = useState<Rec>({});
  const [lines, setLines] = useState<Record<string, LineRow[]>>({});
  const [saving, setSaving] = useState(false);
  const { names, nodes, spec } = useMemo(() => formSpecification(arch, fields), [arch, fields]);
  const lineFields = useMemo(() => names.filter((name) => fields[name].type === 'one2many' || (fields[name].type === 'many2many' && nodes.find((node) => node.name === name)?.views?.list)), [names, fields, nodes]);

  const load = useCallback(async () => {
    let loaded: Rec;
    if (recordId) {
      // Same key as the list's hover prefetch: an already-fetched record opens instantly.
      [loaded] = await rpc<Rec[]>('webRead', model, { ids: [recordId], specification: spec }, { context, cacheMs: RECORD_CACHE_MS });
      if (!loaded) { setRecord(null); return; }
    } else {
      const defaults = await rpc<Rec>('defaultGet', model, { fields: names }, { context });
      loaded = { id: false };
      for (const name of names) loaded[name] = defaults[name] ?? (fields[name].type === 'one2many' || fields[name].type === 'many2many' ? [] : false);
      for (const name of names) {
        const field = fields[name];
        if (field.type === 'many2one' && typeof loaded[name] === 'number') {
          const found = await rpc<[number, string][]>('nameSearch', field.relation!, { domain: [['id', '=', loaded[name]]], limit: 1 }, { silent: true }).catch(() => []);
          loaded[name] = found[0] ? { id: found[0][0], display_name: found[0][1] } : false;
        }
        if (field.type === 'many2many' && Array.isArray(loaded[name]) && Array.isArray((loaded[name] as unknown[])[0])) {
          const ids = ((loaded[name] as unknown[])[0] as [number, number, number[]])[2] ?? [];
          loaded[name] = ids.length ? await rpc<Rec[]>('read', field.relation!, { ids, fields: ['display_name'] }, { silent: true }).catch(() => []) : [];
        }
      }
    }
    setRecord(loaded);
    setChanges({});
    const next: Record<string, LineRow[]> = {};
    for (const name of lineFields) next[name] = rowsFromRecords(loaded[name]);
    setLines(next);
  }, [recordId, model, spec, names, fields, context, lineFields]);

  useEffect(() => { load().catch(() => undefined); }, [load]);

  const values = useMemo<Rec>(() => {
    const merged: Rec = { ...(record ?? {}), ...changes };
    for (const [name, rows] of Object.entries(lines)) merged[name] = rows.filter((row) => !row.deleted).map((row) => row.values);
    return merged;
  }, [record, changes, lines]);
  const scope = useMemo(() => makeRecordScope(values, { uid: user.uid, context, companyIds: user.companyIds, fields }), [values, user, context]);
  const dirty = Object.keys(changes).length > 0 || Object.values(lines).some(hasLineChanges);

  useEffect(() => {
    if (mode !== 'page') return;
    const title = document.getElementById('o_breadcrumb_current');
    if (title && record) title.textContent = recordId ? String(values.display_name ?? values.name ?? '') : t('New');
  }, [record, values, recordId, t, mode]);

  const setValue = async (name: string, value: unknown) => {
    setChanges((current) => ({ ...current, [name]: value }));
    // Server onchange rules for the changed field (partner → addresses, …).
    try {
      const plain: Rec = {};
      for (const [key, current] of Object.entries({ ...values, [name]: value })) {
        plain[key] = current && typeof current === 'object' && !Array.isArray(current) ? idOf(current) : Array.isArray(current) ? (current as unknown[]).map((item) => idOf(item) ?? item) : current;
      }
      const result = await rpc<{ value?: Rec; warning?: { title: string; message: string } }>('onchange', model, { values: plain, fields: [name] }, { silent: true, context });
      if (result.warning) ui.openDialog({ title: result.warning.title, size: 'sm', body: <div>{result.warning.message}</div> });
      if (result.value) {
        const resolved: Rec = {};
        for (const [key, incoming] of Object.entries(result.value)) {
          const def = fields[key];
          if (!def) continue;
          if (def.type === 'many2one' && typeof incoming === 'number') {
            const found = await rpc<[number, string][]>('nameSearch', def.relation!, { domain: [['id', '=', incoming]], limit: 1 }, { silent: true }).catch(() => []);
            resolved[key] = found[0] ? { id: found[0][0], display_name: found[0][1] } : false;
          } else if (def.type === 'many2one' && Array.isArray(incoming)) {
            resolved[key] = { id: incoming[0], display_name: incoming[1] };
          } else {
            resolved[key] = incoming;
          }
        }
        setChanges((current) => ({ ...current, ...resolved }));
      }
    } catch { /* onchange is advisory */ }
  };

  /** Wire values → write values (many2one objects → ids, tags → replace command, lines → commands). */
  const writeValues = (): Rec => {
    const out: Rec = {};
    for (const [name, value] of Object.entries(changes)) {
      const field = fields[name];
      if (!field || lineFields.includes(name)) continue;
      if (field.type === 'many2one') out[name] = idOf(value) ?? false;
      else if (field.type === 'many2many') out[name] = [[6, 0, (value as unknown[]).map((item) => idOf(item)).filter((id): id is number => id !== null)]];
      else if (field.type === 'one2many') continue;
      else out[name] = value;
    }
    for (const [name, rows] of Object.entries(lines)) {
      if (!hasLineChanges(rows)) continue;
      const comodel = fields[name].relation ?? '';
      out[name] = toCommands(rows, relatedFields[comodel] ?? {});
    }
    return out;
  };

  const save = async (): Promise<number | null> => {
    if (!dirty && recordId) return recordId;
    setSaving(true);
    try {
      const saved = await rpc<Rec>('webSave', model, { id: recordId ?? undefined, values: writeValues(), specification: spec }, { context });
      setRecord(saved);
      setChanges({});
      const next: Record<string, LineRow[]> = {};
      for (const name of lineFields) next[name] = rowsFromRecords(saved[name]);
      setLines(next);
      if (!recordId && mode === 'page') navigate(`/odoo/${slug}/${saved.id}`, { replace: true });
      return saved.id as number;
    } catch {
      return null;
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (recordId) { setChanges({}); const next: Record<string, LineRow[]> = {}; for (const name of lineFields) next[name] = rowsFromRecords(record?.[name]); setLines(next); }
    else if (mode === 'dialog') onDone?.(false);
    else navigate(`/odoo/${slug}`);
  };

  const buttonContext = (button: ButtonNode): Record<string, unknown> => {
    if (!button.context) return {};
    try { return (evaluate(button.context, scope) as Record<string, unknown>) ?? {}; } catch { return {}; }
  };

  const clickButton = async (button: ButtonNode) => {
    if (button.special === 'cancel') { onDone?.(false); return; }
    if (button.confirm && !(await ui.confirm({ message: button.confirm }))) return;
    const id = await save();
    if (!id) return;
    const extra = buttonContext(button);
    if (button.type === 'object' && button.name) {
      try {
        const result = await rpc<Record<string, unknown> | false>('callButton', model, { ids: [id], method: button.name, context: { ...context, ...extra } }, { context: { ...context, ...extra } });
        if (mode === 'dialog') {
          if (!result) { onDone?.(true); return; }
          await doAction(result, { onClose: () => onDone?.(true) });
          if (result && (result as Record<string, unknown>).type !== 'ir.actions.act_window' || ((result as Record<string, unknown>).target !== 'new')) onDone?.(true);
          return;
        }
        if (result) await doAction(result, { activeId: id, activeIds: [id], activeModel: model, onClose: () => void load() });
        await load();
      } catch { /* dialog already shown */ }
    } else if (button.type === 'action' && button.name) {
      await doAction(button.name, { activeId: id, activeIds: [id], activeModel: model, context: { ...context, ...extra }, onClose: (changed) => { if (changed) void load(); } });
    }
  };

  useEffect(() => {
    if (mode !== 'page') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      if (event.altKey && event.key.toLowerCase() === 'j') { event.preventDefault(); discard(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!record) return mode === 'dialog' ? <div className="o_loading_indicator" /> : <FormSkeleton />;

  const header = arch.body.find((node): node is Extract<FormNode, { kind: 'header' }> => node.kind === 'header');
  const footer = findFooter(arch.body);
  const hasChatter = mode === 'page' && arch.body.some((node) => node.kind === 'chatter');
  const ctx: RenderCtx = { values, fields, relatedFields, scope, setValue, clickButton, lines, setLines, footer };

  // C-6: the settings page is a transient form with its own layout; Save = create + execute.
  if (mode === 'page' && arch.jsClass === 'base_settings') {
    const saveSettings = async () => {
      const id = await save();
      if (!id) return;
      const result = await rpc<Record<string, unknown> | false>('callButton', model, { ids: [id], method: 'execute' }, { context }).catch(() => false);
      if (result && typeof result === 'object') await doAction(result); else window.location.reload();
    };
    return (
      <SettingsPage arch={arch} fields={fields} values={values} scope={scope} renderNode={(node, key) => <Node key={key} node={node} ctx={ctx} />}
        dirty={dirty} saving={saving} onSave={() => void saveSettings()} onDiscard={() => window.location.reload()} />
    );
  }

  if (mode === 'dialog') {
    return (
      <div className="o_form_view o_form_dialog">
        <div className="o_form_sheet_bg p-0">
          <div className="o_form_sheet border-0 p-0" style={{ maxWidth: 'none' }}>
            {arch.body.filter((node) => node.kind !== 'header' && node.kind !== 'chatter' && node !== footer).map((node, index) => <Node key={index} node={node} ctx={ctx} />)}
          </div>
        </div>
        <div className="o_dialog_footer px-0 pb-0">
          {(footer?.children.filter((node): node is ButtonNode => node.kind === 'button') ?? [{ kind: 'button', type: 'object', name: undefined, string: { en: 'Save', ar: 'حفظ' }, class: 'btn-primary', attrs: {} } as ButtonNode])
            .filter((button) => !isInvisible(button, scope))
            .map((button, index) => (
              <button key={index} type="button" className={`btn ${/btn-primary|oe_highlight/.test(button.class ?? '') ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => (button.special === 'cancel' ? onDone?.(false) : button.type === 'object' && !button.name ? save().then((id) => id && onDone?.(true)) : clickButton(button))}>
                {t(button.string ?? (button.special === 'cancel' ? 'Discard' : 'Save'))}
              </button>
            ))}
          {!footer && <button type="button" className="btn btn-secondary" onClick={() => onDone?.(false)}>{t('Discard')}</button>}
        </div>
      </div>
    );
  }

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

function findFooter(nodes: FormNode[]): Extract<FormNode, { kind: 'element' }> | null {
  for (const node of nodes) {
    if (node.kind === 'element' && node.tag === 'footer') return node;
    if ('children' in node) { const found = findFooter(node.children); if (found) return found; }
  }
  return null;
}

interface RenderCtx {
  values: Rec;
  fields: Record<string, FieldDef>;
  relatedFields: Record<string, Record<string, FieldDef>>;
  scope: ReturnType<typeof makeRecordScope>;
  setValue: (name: string, value: unknown) => void;
  clickButton: (button: ButtonNode) => void;
  lines: Record<string, LineRow[]>;
  setLines: (updater: (current: Record<string, LineRow[]>) => Record<string, LineRow[]>) => void;
  footer: FormNode | null;
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
      if (node === ctx.footer) return null;
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
  const readonly = isReadonly(node, field, ctx.scope);
  const required = isRequired(node, field, ctx.scope);
  const embedded = node.views?.list;
  const isLines = field.type === 'one2many' || (field.type === 'many2many' && embedded);
  let control: ReactNode;
  if (isLines && embedded && embedded.type === 'list' && field.relation) {
    control = (
      <EmbeddedList node={node} field={field} arch={embedded} comodelFields={ctx.relatedFields[field.relation] ?? {}}
        rows={ctx.lines[node.name] ?? []} parent={ctx.values} readonly={readonly}
        onChange={(rows) => ctx.setLines((current) => ({ ...current, [node.name]: rows }))} />
    );
  } else if (isLines) {
    const rows = ctx.lines[node.name] ?? [];
    control = <div className="o_field_widget o_readonly text-muted">{rows.filter((row) => !row.deleted).map((row) => nameOf(row.values) || String(row.id ?? '')).join(', ') || t('None')}</div>;
  } else {
    control = <Field node={node} field={field} value={ctx.values[node.name]} record={ctx.values} readonly={readonly} required={required} onChange={(value) => ctx.setValue(node.name, value)} />;
  }
  if (node.class && !isLines) control = <div className={node.class}>{control}</div>;
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
