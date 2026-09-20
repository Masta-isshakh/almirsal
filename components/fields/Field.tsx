'use client';

import { useEffect, useRef, useState } from 'react';
import type { FieldNode } from '@engine/registry/arch';
import type { FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatValue, idOf, nameOf, useCurrencies } from '@/lib/client/display';
import { GroupsField } from './GroupsField';
import {
  BadgesMany2OneField, BooleanFavoriteField, CodeField, ColorPickerField, CopyClipboardField, DateRangeField, ImageField, LinkField,
  Many2ManyCheckboxesField, Many2OneAvatarField, PercentPieField, ProgressBarField, RemainingDaysField, DatePickerField, TaxTotalsField,
} from './widgets';

type Rec = Record<string, unknown>;

export interface FieldProps {
  node: FieldNode;
  field: FieldDef;
  value: unknown;
  record: Rec;
  readonly: boolean;
  required: boolean;
  onChange: (value: unknown) => void;
}

/**
 * Field widgets (A-4 §6). Inputs are Odoo's underline style: no box, bottom
 * border that darkens on focus. Readonly renders the formatted text.
 */
export function Field(props: FieldProps) {
  const { node, field, value, readonly } = props;
  const widget = node.widget ?? '';
  const lang = useLang();
  const currencies = useCurrencies();

  if (widget === 'priority') return <PriorityField {...props} />;
  if (widget === 'many2many_tags' || widget === 'many2many_tags_avatar') return <TagsField {...props} />;
  if (widget === 'many2many_checkboxes') return <Many2ManyCheckboxesField {...props} />;
  if (widget === 'res_user_group_ids') return <GroupsField {...props} />;
  if (widget === 'badge' || widget === 'label_selection') {
    return <span className="badge rounded-pill text-bg-secondary">{formatValue(field, value, { lang, record: props.record, currencies })}</span>;
  }
  if (widget === 'image' || widget === 'contact_image' || widget === 'image_url' || field.type === 'image' || field.type === 'binary') return <ImageField {...props} />;
  if (widget === 'boolean_toggle') return <ToggleField {...props} />;
  if (widget === 'boolean_favorite') return <BooleanFavoriteField {...props} />;
  if (widget === 'color_picker' || widget === 'color') return <ColorPickerField {...props} />;
  if (widget === 'progressbar') return <ProgressBarField {...props} />;
  if (widget === 'percentpie') return <PercentPieField {...props} />;
  if (widget.startsWith('CopyClipboard')) return <CopyClipboardField {...props} />;
  if (widget === 'remaining_days') return <RemainingDaysField {...props} />;
  if (widget === 'account-tax-totals-field') return <TaxTotalsField {...props} />;
  if (widget === 'sale-extra-totals') return null;
  if (widget === 'document_tax_mode_selector') return <TaxModeBadge {...props} />;
  if (widget === 'daterange') return <DateRangeField {...props} />;
  if (widget === 'url' || widget === 'email' || widget === 'phone') return <LinkField {...props} />;
  if (widget === 'ace' || widget === 'domain' || widget === 'code_editor' || widget === 'json') return <CodeField {...props} />;
  if (widget === 'badges_many2one' && field.type === 'many2one') return <BadgesMany2OneField {...props} editor={<Many2OneField {...props} />} />;
  if ((widget === 'many2one_avatar' || widget === 'many2one_avatar_user' || widget === 'many2one_avatar_employee') && field.type === 'many2one') {
    return <Many2OneAvatarField {...props} editor={<Many2OneField {...props} />} />;
  }

  switch (field.type) {
    case 'boolean': return <BooleanField {...props} />;
    case 'selection': return <SelectionField {...props} />;
    case 'many2one': return <Many2OneField {...props} />;
    case 'one2many':
    case 'many2many': return <TagsField {...props} />;
    case 'text':
    case 'html': return <TextField {...props} />;
    case 'integer':
    case 'float':
    case 'monetary': return <NumberField {...props} />;
    case 'date':
    case 'datetime': return <DatePickerField {...props} />;
    default: return readonly ? <ReadonlyText {...props} /> : <CharField {...props} />;
  }
}

/** The small "Tax Excl. / Tax Incl." pill on documents: click flips the mode. */
function TaxModeBadge({ field, value, readonly, onChange }: FieldProps) {
  const t = useT();
  const options = field.selection ?? [];
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  const next = options[(options.indexOf(current) + 1) % options.length];
  return (
    <button type="button" className="badge rounded-pill text-bg-light border ms-auto" disabled={readonly} title={t('Switch price mode')} onClick={() => onChange(next.value)}>
      {t(current.label)}
    </button>
  );
}

function ReadonlyText({ field, value, record, node }: FieldProps) {
  const lang = useLang();
  const currencies = useCurrencies();
  const text = formatValue(field, value, { lang, widget: node.widget, record, currencies });
  if (node.widget === 'url' && text) return <a href={text} target="_blank" rel="noreferrer">{text}</a>;
  if (node.widget === 'email' && text) return <a href={`mailto:${text}`}>{text}</a>;
  return <span className="o_field_widget o_readonly">{text}</span>;
}

function CharField({ node, value, readonly, required, onChange }: FieldProps) {
  const t = useT();
  return (
    <div className={`o_field_widget ${readonly ? 'o_readonly' : ''}`}>
      <input className="o_input" type={node.widget === 'email' ? 'email' : node.password ? 'password' : 'text'}
        value={value === false || value == null ? '' : String(value)} placeholder={t(node.placeholder)}
        readOnly={readonly} required={required} onChange={(event) => onChange(event.target.value || false)} />
    </div>
  );
}

function TextField({ node, value, readonly, onChange, field }: FieldProps) {
  const t = useT();
  const text = value === false || value == null ? '' : String(value);
  const plain = field.type === 'html' ? text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '') : text;
  if (readonly) {
    if (!plain.trim()) return null;
    return field.type === 'html'
      ? <div className="o_field_widget o_readonly" dangerouslySetInnerHTML={{ __html: text }} />
      : <div className="o_field_widget o_readonly" style={{ whiteSpace: 'pre-wrap' }}>{plain}</div>;
  }
  return (
    <div className={`o_field_widget ${readonly ? 'o_readonly' : ''}`}>
      <textarea className="o_input" rows={Math.min(12, Math.max(2, plain.split('\n').length))} value={plain} placeholder={t(node.placeholder)}
        readOnly={readonly} onChange={(event) => onChange(field.type === 'html' ? `<p>${event.target.value.replace(/\n/g, '<br/>')}</p>` : event.target.value || false)} />
    </div>
  );
}

function NumberField({ field, node, value, readonly, record, onChange }: FieldProps) {
  const lang = useLang();
  const currencies = useCurrencies();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (readonly || !editing) {
    return (
      <div className={`o_field_widget o_field_${field.type} ${readonly ? 'o_readonly' : ''}`} onClick={() => { if (!readonly) { setDraft(value === false || value == null ? '' : String(value)); setEditing(true); } }}>
        <input className="o_input" readOnly value={formatValue(field, value, { lang, widget: node.widget, record, currencies })} />
      </div>
    );
  }
  return (
    <div className={`o_field_widget o_field_${field.type}`}>
      <input className="o_input" type="number" step={field.type === 'integer' ? 1 : 'any'} value={draft} autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { setEditing(false); onChange(draft === '' ? 0 : Number(draft)); }}
        onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
    </div>
  );
}

function BooleanField({ value, readonly, onChange }: FieldProps) {
  return (
    <div className="o_field_widget o_field_boolean">
      <input type="checkbox" className="form-check-input" checked={Boolean(value)} disabled={readonly} onChange={(event) => onChange(event.target.checked)} />
    </div>
  );
}

function ToggleField({ value, readonly, onChange }: FieldProps) {
  return (
    <div className="o_field_widget form-check form-switch">
      <input type="checkbox" className="form-check-input" role="switch" checked={Boolean(value)} disabled={readonly} onChange={(event) => onChange(event.target.checked)} />
    </div>
  );
}

function SelectionField({ field, value, readonly, required, onChange, node }: FieldProps) {
  const t = useT();
  if (node.widget === 'radio') {
    return (
      <div className="o_field_widget d-flex flex-wrap gap-3">
        {field.selection?.map((option) => (
          <label key={option.value} className="d-flex align-items-center gap-1">
            <input type="radio" className="form-check-input m-0" checked={value === option.value} disabled={readonly} onChange={() => onChange(option.value)} />{t(option.label)}
          </label>
        ))}
      </div>
    );
  }
  return (
    <div className={`o_field_widget ${readonly ? 'o_readonly' : ''}`}>
      <select className="o_input" value={value === false || value == null ? '' : String(value)} disabled={readonly} required={required}
        onChange={(event) => onChange(event.target.value || false)}>
        {!required && <option value="" />}
        {field.selection?.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
      </select>
    </div>
  );
}

function PriorityField({ field, value, readonly, onChange }: FieldProps) {
  const levels = (field.selection?.length ?? 4) - 1;
  const current = Number(value) || 0;
  return (
    <div className="o_field_widget">
      {Array.from({ length: levels }, (_, index) => index + 1).map((star) => (
        <i key={star} className={`fa ${current >= star ? 'fa-star text-warning' : 'fa-star-o text-muted'} me-1`} style={{ cursor: readonly ? 'default' : 'pointer' }}
          onClick={() => { if (!readonly) onChange(String(current === star ? 0 : star)); }} />
      ))}
    </div>
  );
}

/** A-4 §6 many2one: dropdown of 8 matches, "Search More…", "Create…". */
export function Many2OneField({ field, value, readonly, required, onChange, node }: FieldProps) {
  const t = useT();
  const [text, setText] = useState(nameOf(value));
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<[number, string][]>([]);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const noCreate = /no_create|no_quick_create/.test(node.options ?? '');
  const noOpen = /no_open/.test(node.options ?? '');

  useEffect(() => { setText(nameOf(value)); }, [value]);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(async () => {
      try {
        const rows = await rpc<[number, string][]>('nameSearch', field.relation!, { name: text === nameOf(value) ? '' : text, limit: 8 }, { silent: true });
        setItems(rows);
        setActive(0);
      } catch { setItems([]); }
    }, 150);
    return () => clearTimeout(handle);
  }, [open, text, field.relation, value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) { setOpen(false); setText(nameOf(value)); } };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, value]);

  const choose = (item: [number, string]) => { onChange({ id: item[0], display_name: item[1] }); setText(item[1]); setOpen(false); };

  const createQuick = async () => {
    if (!text.trim()) return;
    try {
      const id = await rpc<number>('create', field.relation!, { values: { name: text.trim() } });
      choose([id, text.trim()]);
    } catch { /* dialog shown by the rpc listener */ }
  };

  if (readonly) {
    const id = idOf(value);
    return <span className="o_field_widget o_readonly">{id && !noOpen ? <a href={`#/${field.relation}/${id}`} onClick={(e) => e.preventDefault()}>{nameOf(value)}</a> : nameOf(value)}</span>;
  }

  return (
    <div className="o_field_widget o_field_many2one" ref={box}>
      <input className="o_input" value={text} placeholder={t(node.placeholder)} required={required}
        onFocus={() => setOpen(true)} onChange={(event) => { setText(event.target.value); setOpen(true); if (!event.target.value) onChange(false); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
          if (event.key === 'Enter' && open && items[active]) { event.preventDefault(); choose(items[active]); }
          if (event.key === 'Escape') { setOpen(false); setText(nameOf(value)); }
        }} />
      {idOf(value) && !noOpen && <button type="button" className="o_external_button" title={t('Internal link')}><i className="fa fa-arrow-right" /></button>}
      {open && (
        <div className="o_m2o_dropdown">
          {items.map((item, index) => (
            <div key={item[0]} className={`o_m2o_dropdown_item ${index === active ? 'active' : ''}`} onMouseDown={() => choose(item)}>{item[1]}</div>
          ))}
          {items.length === 0 && <div className="o_m2o_dropdown_item text-muted">{t('No records')}</div>}
          <div className="o_m2o_dropdown_item o_m2o_extra" onMouseDown={() => setOpen(false)}>{t('Search More...')}</div>
          {!noCreate && text.trim() && text !== nameOf(value) && (
            <div className="o_m2o_dropdown_item o_m2o_extra" onMouseDown={createQuick}>{t('Create')} &quot;{text.trim()}&quot;</div>
          )}
        </div>
      )}
    </div>
  );
}

/** many2many_tags: coloured chips plus an inline autocomplete to add. */
function TagsField({ field, value, readonly, onChange, node }: FieldProps) {
  const t = useT();
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const [text, setText] = useState('');
  const [options, setOptions] = useState<[number, string][]>([]);
  const [open, setOpen] = useState(false);
  const colorField = /'color_field'\s*:\s*'(\w+)'/.exec(node.options ?? '')?.[1];

  useEffect(() => {
    if (!open || !field.relation) return;
    const handle = setTimeout(async () => {
      try {
        const rows = await rpc<[number, string][]>('nameSearch', field.relation!, { name: text, limit: 8 }, { silent: true });
        setOptions(rows.filter(([id]) => !items.some((item) => idOf(item) === id)));
      } catch { setOptions([]); }
    }, 150);
    return () => clearTimeout(handle);
  }, [open, text, field.relation, items]);

  const commands = (next: unknown[]) => onChange(next);
  const remove = (id: number | null) => commands(items.filter((item) => idOf(item) !== id));
  const add = (option: [number, string]) => { commands([...items, { id: option[0], display_name: option[1] }]); setText(''); setOpen(false); };

  return (
    <div className="o_field_widget d-flex flex-wrap align-items-center gap-1" style={{ position: 'relative' }}>
      {items.map((item, index) => {
        const color = colorField && item && typeof item === 'object' ? Number((item as Rec)[colorField]) : 0;
        return (
          <span key={index} className="badge rounded-pill" style={{ background: color ? `var(--o-color-${color})` : 'var(--o-gray-200)', color: color ? '#fff' : 'var(--o-text)' }}>
            {nameOf(item) || idOf(item)}
            {!readonly && <button type="button" className="btn-close btn-close-white ms-1" style={{ fontSize: 8 }} aria-label="Remove" onClick={() => remove(idOf(item))} />}
          </span>
        );
      })}
      {!readonly && field.relation && (
        <>
          <input className="o_input" style={{ flex: '1 1 80px', minWidth: 80 }} value={text} placeholder={items.length ? '' : t(node.placeholder)}
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(event) => { setText(event.target.value); setOpen(true); }} />
          {open && options.length > 0 && (
            <div className="o_m2o_dropdown" style={{ top: '100%' }}>
              {options.map((option) => <div key={option[0]} className="o_m2o_dropdown_item" onMouseDown={() => add(option)}>{option[1]}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
