'use client';

import { useState } from 'react';
import type { FieldNode, ListArch } from '@engine/registry/arch';
import type { FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatValue, idOf, nameOf, useCurrencies } from '@/lib/client/display';
import { isInvisible, isReadonly, isRequired, makeRecordScope } from '@/lib/client/arch';
import { Field } from '../../fields/Field';
import { useUi } from '../../webclient/ui';
import { useSession } from '../../webclient/session';
import { Catalog } from './Catalog';
import { newRow, type LineRow, type Rec } from './lines';

interface Props {
  node: FieldNode;
  field: FieldDef;
  arch: ListArch;
  comodelFields: Record<string, FieldDef>;
  rows: LineRow[];
  parent: Rec;
  readonly: boolean;
  onChange: (rows: LineRow[]) => void;
}

/**
 * Editable one2many/many2many list inside a form (A-4 §5): inline editing
 * of the visible columns, "Add a product / section / note" controls, delete
 * per row, product onchange to fill description/price/taxes, and the
 * Catalog dialog on sales lines.
 */
export function EmbeddedList({ node, field, arch, comodelFields, rows, parent, readonly, onChange }: Props) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const user = useSession();
  const currencies = useCurrencies();
  const [editing, setEditing] = useState<number | null>(null);

  const comodel = field.relation ?? '';
  const columns = arch.columns.filter((column): column is FieldNode =>
    column.kind === 'field' && !column.hidden && column.columnInvisible !== true && column.optional !== 'hide' && column.widget !== 'handle' && Boolean(comodelFields[column.name]));
  const visible = rows.filter((row) => !row.deleted);
  const editable = !readonly && arch.editable !== undefined;
  const isSection = (row: LineRow) => typeof row.values.display_type === 'string' && String(row.values.display_type).startsWith('line_');

  const update = (key: number, patch: Rec) => {
    onChange(rows.map((row) => (row.key === key ? { ...row, values: { ...row.values, ...patch }, changes: { ...row.changes, ...patch } } : row)));
  };
  const remove = (key: number) => onChange(rows.map((row) => (row.key === key ? { ...row, deleted: true } : row)));

  const addRow = async (extra: Rec = {}) => {
    const context: Record<string, unknown> = {};
    if (field.inverse && parent.id) context[`default_${field.inverse}`] = parent.id;
    const defaults = await rpc<Rec>('defaultGet', comodel, {}, { context }).catch(() => ({}));
    const values: Rec = { ...defaults, ...extra };
    for (const column of columns) if (!(column.name in values)) values[column.name] = comodelFields[column.name].type === 'many2many' ? [] : false;
    const row = newRow(values);
    onChange([...rows, row]);
    setEditing(row.key);
  };

  /** Apply the comodel's onchange for a changed field to the row. */
  const changeField = async (row: LineRow, name: string, value: unknown) => {
    const patch: Rec = { [name]: value };
    update(row.key, patch);
    const comodelField = comodelFields[name];
    if (!comodelField) return;
    try {
      const values: Rec = {};
      for (const [key, current] of Object.entries({ ...row.values, ...patch })) {
        values[key] = current && typeof current === 'object' && !Array.isArray(current) ? idOf(current) : current;
      }
      const result = await rpc<{ value?: Rec }>('onchange', comodel, { values, fields: [name] }, { silent: true });
      if (result.value && Object.keys(result.value).length) {
        const resolved: Rec = {};
        for (const [key, incoming] of Object.entries(result.value)) {
          const def = comodelFields[key];
          if (def?.type === 'many2one' && typeof incoming === 'number') {
            const found = await rpc<[number, string][]>('nameSearch', def.relation!, { domain: [['id', '=', incoming]], limit: 1 }, { silent: true }).catch(() => []);
            resolved[key] = found[0] ? { id: found[0][0], display_name: found[0][1] } : false;
          } else if (def?.type === 'many2many' && Array.isArray(incoming) && Array.isArray(incoming[0])) {
            const ids = (incoming[0] as [number, number, number[]])[2] ?? [];
            const names = ids.length ? await rpc<Rec[]>('read', def.relation!, { ids, fields: ['display_name'] }, { silent: true }).catch(() => []) : [];
            resolved[key] = names;
          } else {
            resolved[key] = incoming;
          }
        }
        update(row.key, resolved);
      }
    } catch { /* onchange failures are non-blocking */ }
  };

  const subtotal = (row: LineRow): number => {
    const qty = Number(row.values.product_uom_qty ?? row.values.quantity ?? 0);
    const price = Number(row.values.price_unit ?? 0);
    const discount = Number(row.values.discount ?? 0);
    return qty * price * (1 - discount / 100);
  };

  const openCatalog = () => {
    let id = 0;
    id = ui.openDialog({
      title: { en: 'Products', ar: 'المنتجات' },
      size: 'lg',
      footer: null,
      body: (
        <Catalog
          existing={visible.filter((row) => !isSection(row)).map((row) => ({ productId: idOf(row.values.product_id), qty: Number(row.values.product_uom_qty ?? 0), key: row.key }))}
          onDone={async (selection) => {
            ui.closeDialog(id);
            let next = rows;
            for (const item of selection) {
              const current = next.find((row) => !row.deleted && idOf(row.values.product_id) === item.productId);
              if (current) {
                next = next.map((row) => (row.key === current.key ? { ...row, values: { ...row.values, product_uom_qty: item.qty }, changes: { ...row.changes, product_uom_qty: item.qty } } : row));
              } else if (item.qty > 0) {
                const defaults = await rpc<Rec>('defaultGet', comodel, {}, { silent: true }).catch(() => ({}));
                const values: Rec = { ...defaults, product_id: { id: item.productId, display_name: item.name }, product_uom_qty: item.qty, name: item.name, price_unit: item.price, tax_ids: [] };
                const changed = await rpc<{ value?: Rec }>('onchange', comodel, { values: { product_id: item.productId }, fields: ['product_id'] }, { silent: true }).catch(() => ({} as { value?: Rec }));
                if (changed.value?.name) values.name = changed.value.name;
                if (changed.value?.price_unit !== undefined) values.price_unit = changed.value.price_unit;
                next = [...next, newRow(values)];
              }
            }
            onChange(next);
          }}
        />
      ),
    });
  };

  const controls = arch.control.filter((control): control is Extract<typeof control, { kind: 'create' }> => control.kind === 'create');
  const isSaleLines = comodel === 'sale.order.line' || comodel === 'purchase.order.line' || comodel === 'account.move.line';

  return (
    <div className="o_embedded_list">
      <table className="o_list_table">
        <thead>
          <tr>
            {columns.map((column) => {
              const def = comodelFields[column.name];
              const numeric = ['integer', 'float', 'monetary'].includes(def.type);
              return <th key={column.name} className={numeric ? 'o_list_number_th' : ''}>{t(column.string ?? def.label)}</th>;
            })}
            {editable && <th style={{ width: 32 }} />}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const scope = makeRecordScope(row.values, { uid: user.uid, companyIds: user.companyIds, parent });
            const isEditing = editable && editing === row.key;
            if (isSection(row)) {
              const note = row.values.display_type === 'line_note';
              return (
                <tr key={row.key} onClick={() => editable && setEditing(row.key)}>
                  <td colSpan={columns.length} className={note ? 'fst-italic text-muted' : 'fw-bold'}>
                    {isEditing ? (
                      <input className="o_input w-100" value={String(row.values.name ?? '')} autoFocus placeholder={t(note ? 'Add a note' : 'Section name')}
                        onChange={(event) => update(row.key, { name: event.target.value })} onBlur={() => setEditing(null)} />
                    ) : String(row.values.name ?? '')}
                  </td>
                  {editable && <td><button type="button" className="btn btn-link btn-sm text-muted p-0" onClick={(event) => { event.stopPropagation(); remove(row.key); }} aria-label={t('Delete')}><i className="fa fa-trash-o" /></button></td>}
                </tr>
              );
            }
            return (
              <tr key={row.key} onClick={() => editable && setEditing(row.key)}>
                {columns.map((column) => {
                  const def = comodelFields[column.name];
                  const numeric = ['integer', 'float', 'monetary'].includes(def.type);
                  const invisible = isInvisible(column, scope);
                  if (invisible) return <td key={column.name} />;
                  const value = row.values[column.name];
                  if (isEditing) {
                    const cellReadonly = isReadonly(column, def, scope);
                    return (
                      <td key={column.name} className={numeric ? 'o_list_number' : ''} onClick={(event) => event.stopPropagation()}>
                        <Field node={column} field={def} value={value} record={row.values} readonly={cellReadonly} required={isRequired(column, def, scope)}
                          onChange={(next) => changeField(row, column.name, next)} />
                      </td>
                    );
                  }
                  const text = column.name === 'price_subtotal' && !row.id
                    ? formatValue(def, subtotal(row), { lang, record: { ...row.values, currency_id: parent.currency_id }, currencies })
                    : formatValue(def, value, { lang, widget: column.widget, record: { ...row.values, currency_id: row.values.currency_id ?? parent.currency_id }, currencies });
                  return <td key={column.name} className={numeric ? 'o_list_number' : ''}>{column.widget === 'many2many_tags' && Array.isArray(value) ? value.map((item, index) => <span key={index} className="badge rounded-pill text-bg-secondary me-1">{nameOf(item)}</span>) : text}</td>;
                })}
                {editable && <td><button type="button" className="btn btn-link btn-sm text-muted p-0" onClick={(event) => { event.stopPropagation(); remove(row.key); }} aria-label={t('Delete')}><i className="fa fa-trash-o" /></button></td>}
              </tr>
            );
          })}
          {visible.length === 0 && !editable && <tr><td colSpan={columns.length} className="text-muted">{t('No lines')}</td></tr>}
        </tbody>
      </table>
      {editable && (
        <div className="o_list_add">
          {(controls.length ? controls : [{ kind: 'create' as const, string: { en: 'Add a line', ar: 'إضافة بند' }, context: undefined as string | undefined, name: undefined as string | undefined }]).map((control, index) => {
            const ctx = control.context ?? '';
            const extra: Rec = /line_section/.test(ctx) ? { display_type: 'line_section', name: '' } : /line_note/.test(ctx) ? { display_type: 'line_note', name: '' } : {};
            return <a key={index} href="#add" onClick={(event) => { event.preventDefault(); void addRow(extra); }}>{t(control.string)}</a>;
          })}
          {isSaleLines && comodelFields.product_id && <a href="#catalog" onClick={(event) => { event.preventDefault(); openCatalog(); }}>{t('Catalog')}</a>}
        </div>
      )}
    </div>
  );
}
