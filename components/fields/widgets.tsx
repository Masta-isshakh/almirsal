'use client';

import { useEffect, useRef, useState } from 'react';
import { PyDate } from '@engine/expr/pydate';
import { daysUntil, formatDate } from '@engine/format/index';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatValue, idOf, nameOf, useCurrencies } from '@/lib/client/display';
import { avatarColor } from '../webclient/Navbar';
import type { FieldProps } from './Field';

/**
 * The remaining A-4 §6 widgets: favorites star, colour picker, progress bar,
 * copy-to-clipboard, remaining days, image upload, checkbox lists, date
 * ranges, links (url/email/phone), code editors, avatar many2ones.
 */

export function BooleanFavoriteField({ value, readonly, onChange }: FieldProps) {
  const t = useT();
  const on = Boolean(value);
  return (
    <div className="o_field_widget">
      <i className={`fa ${on ? 'fa-star text-warning' : 'fa-star-o text-muted'}`} style={{ cursor: readonly ? 'default' : 'pointer' }}
        title={t(on ? 'Remove from favorites' : 'Add to favorites')} onClick={() => { if (!readonly) onChange(!on); }} />
    </div>
  );
}

export function ColorPickerField({ value, readonly, onChange }: FieldProps) {
  const current = Number(value) || 0;
  const [open, setOpen] = useState(false);
  return (
    <div className="o_field_widget" style={{ position: 'relative' }}>
      <span className="d-inline-block rounded-circle" style={{ width: 20, height: 20, background: current ? `var(--o-color-${current})` : 'var(--o-gray-200)', cursor: readonly ? 'default' : 'pointer' }}
        onClick={() => { if (!readonly) setOpen((state) => !state); }} />
      {open && (
        <div className="o_m2o_dropdown d-flex flex-wrap gap-1 p-2" style={{ width: 160 }}>
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} className="rounded-circle" style={{ width: 20, height: 20, background: index ? `var(--o-color-${index})` : 'var(--o-gray-200)', cursor: 'pointer', outline: index === current ? '2px solid var(--o-text)' : 'none' }}
              onClick={() => { onChange(index); setOpen(false); }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProgressBarField({ value, node, record, readonly, onChange }: FieldProps) {
  const maxField = /'max_value'\s*:\s*'(\w+)'/.exec(node.options ?? '')?.[1];
  const max = maxField ? Number(record[maxField]) || 100 : 100;
  const current = Number(value) || 0;
  const percent = Math.max(0, Math.min(100, (current / max) * 100));
  const editable = !readonly && /'editable'\s*:\s*[Tt]rue/.test(node.options ?? '');
  const [editing, setEditing] = useState(false);
  return (
    <div className="o_field_widget o_progressbar d-flex align-items-center gap-2" onClick={() => { if (editable) setEditing(true); }}>
      <div className="progress flex-grow-1" style={{ height: 8, minWidth: 80 }}>
        <div className={`progress-bar ${percent >= 100 ? 'bg-success' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      {editing ? (
        <input className="o_input" style={{ width: 56 }} type="number" defaultValue={current} autoFocus
          onBlur={(event) => { setEditing(false); onChange(Number(event.target.value) || 0); }}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
      ) : <span className="small">{Math.round(percent)}%</span>}
    </div>
  );
}

export function CopyClipboardField(props: FieldProps) {
  const { value, node, field, record } = props;
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const [copied, setCopied] = useState(false);
  const text = formatValue(field, value, { lang, record, currencies });
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const button = (
    <button type="button" className="btn btn-secondary btn-sm o_clipboard_button" onClick={copy} disabled={!text}>
      <i className={`fa ${copied ? 'fa-check' : 'fa-clipboard'} me-1`} />{t(copied ? 'Copied' : 'Copy')}
    </button>
  );
  if (node.widget === 'CopyClipboardButton') return <div className="o_field_widget">{button}</div>;
  return (
    <div className="o_field_widget d-flex align-items-center gap-2">
      {node.widget === 'CopyClipboardURL' && text ? <a href={text} target="_blank" rel="noreferrer" className="text-truncate">{text}</a> : <span className="text-truncate">{text}</span>}
      {button}
    </div>
  );
}

export function RemainingDaysField({ value, field, readonly, onChange, record }: FieldProps) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  if (!value) return readonly ? <span className="o_field_widget o_readonly" /> : <DateInput value={value} field={field} onChange={onChange} />;
  const today = PyDate.parse(new Date().toISOString().slice(0, 10))!;
  const days = daysUntil(String(value), today) ?? 0;
  const label = days === 0 ? t('Today') : days === 1 ? t('Tomorrow') : days === -1 ? t('Yesterday')
    : days > 0 ? `${t('In')} ${days} ${t('days')}` : `${Math.abs(days)} ${t('days ago')}`;
  const cls = days < 0 ? 'text-danger fw-bold' : days === 0 ? 'text-warning fw-bold' : '';
  const [editing, setEditing] = useState(false);
  if (editing) return <DateInput value={value} field={field} onChange={(next) => { setEditing(false); onChange(next); }} />;
  return (
    <div className={`o_field_widget ${cls}`} title={formatValue(field, value, { lang, record, currencies })} style={{ cursor: readonly ? 'default' : 'pointer' }} onClick={() => { if (!readonly) setEditing(true); }}>{label}</div>
  );
}

function DateInput({ value, field, onChange }: { value: unknown; field: FieldProps['field']; onChange: (value: unknown) => void }) {
  const text = value === false || value == null ? '' : String(value);
  return (
    <div className="o_field_widget">
      <input className="o_input" type="date" value={text.slice(0, 10)} autoFocus
        onChange={(event) => onChange(event.target.value ? (field.type === 'date' ? event.target.value : `${event.target.value} 00:00:00`) : false)} />
    </div>
  );
}

export function DateRangeField(props: FieldProps) {
  const { node, record, field, value, readonly, onChange } = props;
  const lang = useLang();
  const endField = /'end_date_field'\s*:\s*'(\w+)'/.exec(node.options ?? '')?.[1];
  const startField = /'start_date_field'\s*:\s*'(\w+)'/.exec(node.options ?? '')?.[1];
  const other = endField ?? startField;
  const otherValue = other ? record[other] : undefined;
  const text = (input: unknown) => (input === false || input == null ? '' : String(input).slice(0, 10));
  if (readonly) {
    const first = endField ? value : otherValue;
    const second = endField ? otherValue : value;
    return <span className="o_field_widget o_readonly">{first ? formatDate(String(first), lang) : ''}{second ? ` → ${formatDate(String(second), lang)}` : ''}</span>;
  }
  return (
    <div className="o_field_widget d-flex align-items-center gap-1">
      <input className="o_input" type="date" value={text(value)} onChange={(event) => onChange(event.target.value ? (field.type === 'date' ? event.target.value : `${event.target.value} 00:00:00`) : false)} />
      {other && <><span className="text-muted">→</span><input className="o_input" type="date" value={text(otherValue)} readOnly /></>}
    </div>
  );
}

/** url / email / phone: editable input, readonly renders a link. */
export function LinkField({ node, value, readonly, required, onChange }: FieldProps) {
  const t = useT();
  const text = value === false || value == null ? '' : String(value);
  if (readonly) {
    if (!text) return <span className="o_field_widget o_readonly" />;
    const href = node.widget === 'email' ? `mailto:${text}` : node.widget === 'phone' ? `tel:${text.replace(/\s+/g, '')}` : /^https?:/.test(text) ? text : `https://${text}`;
    return <span className="o_field_widget o_readonly"><a href={href} target={node.widget === 'url' ? '_blank' : undefined} rel="noreferrer">{text}</a></span>;
  }
  return (
    <div className="o_field_widget d-flex align-items-center gap-2">
      <input className="o_input" type={node.widget === 'email' ? 'email' : node.widget === 'phone' ? 'tel' : 'url'} value={text} placeholder={t(node.placeholder)} required={required}
        onChange={(event) => onChange(event.target.value || false)} />
      {text && node.widget === 'email' && <a href={`mailto:${text}`} className="text-muted" title={t('Send email')}><i className="fa fa-envelope" /></a>}
      {text && node.widget === 'phone' && <a href={`tel:${text}`} className="text-muted" title={t('Call')}><i className="fa fa-phone" /></a>}
      {text && node.widget === 'url' && <a href={/^https?:/.test(text) ? text : `https://${text}`} target="_blank" rel="noreferrer" className="text-muted"><i className="fa fa-external-link" /></a>}
    </div>
  );
}

/** ace / domain / code_editor: monospace textarea (domains keep their Python literal). */
export function CodeField({ value, readonly, onChange, node }: FieldProps) {
  const text = value === false || value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <div className={`o_field_widget ${readonly ? 'o_readonly' : ''}`}>
      <textarea className="o_input font-monospace small" rows={Math.min(16, Math.max(3, text.split('\n').length + 1))} value={text} readOnly={readonly} spellCheck={false}
        placeholder={node.widget === 'domain' ? '[]' : ''} onChange={(event) => onChange(event.target.value || false)} />
    </div>
  );
}

/** Image upload: preview, file picker (data URL, ≤ 2 MB), clear. */
export function ImageField({ value, field, readonly, onChange, node }: FieldProps) {
  const t = useT();
  const size = /'size'\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(node.options ?? '');
  const width = size ? Number(size[1]) : 90;
  const height = size ? Number(size[2]) : 90;
  const isImage = field.type === 'image' || node.widget === 'image' || node.widget === 'contact_image' || (typeof value === 'string' && value.startsWith('data:image'));
  const src = typeof value === 'string' && value ? (value.startsWith('data:') ? value : `data:image/png;base64,${value}`) : null;
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = isImage ? 'image/*' : '*/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { window.alert(t('The file is too large (max 2 MB).')); return; }
      const reader = new FileReader();
      reader.onload = () => onChange(String(reader.result));
      reader.readAsDataURL(file);
    };
    input.click();
  };
  if (!isImage) {
    return (
      <div className="o_field_widget d-flex align-items-center gap-2">
        {src ? <a href={src} download className="text-truncate"><i className="fa fa-download me-1" />{t('Download')}</a> : <span className="text-muted">{t('No file')}</span>}
        {!readonly && <button type="button" className="btn btn-secondary btn-sm" onClick={pick}><i className="fa fa-upload" /></button>}
        {!readonly && src && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(false)}><i className="fa fa-trash-o" /></button>}
      </div>
    );
  }
  return (
    <div className="o_field_widget o_field_image position-relative" style={{ width, height }}>
      <div style={{ width, height, border: src ? 'none' : '1px dashed var(--o-border)', borderRadius: /rounded/.test(node.options ?? '') ? 12 : 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--o-text-muted)', overflow: 'hidden', cursor: readonly ? 'default' : 'pointer' }}
        onClick={() => { if (!readonly) pick(); }}>
        {src ? <img src={src} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <i className="fa fa-camera fa-2x" />}
      </div>
      {!readonly && src && (
        <button type="button" className="btn btn-light btn-sm position-absolute" style={{ top: 2, right: 2, padding: '0 6px' }} onClick={() => onChange(false)} title={t('Clear')}><i className="fa fa-trash-o" /></button>
      )}
    </div>
  );
}

export function Many2ManyCheckboxesField({ field, value, readonly, onChange }: FieldProps) {
  const [options, setOptions] = useState<[number, string][]>([]);
  useEffect(() => {
    if (!field.relation) return;
    let cancelled = false;
    rpc<[number, string][]>('nameSearch', field.relation, { name: '', limit: 200 }, { silent: true }).then((rows) => { if (!cancelled) setOptions(rows); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [field.relation]);
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const ids = new Set(items.map((item) => idOf(item)));
  const toggle = (option: [number, string]) => {
    if (ids.has(option[0])) onChange(items.filter((item) => idOf(item) !== option[0]));
    else onChange([...items, { id: option[0], display_name: option[1] }]);
  };
  return (
    <div className="o_field_widget d-flex flex-column gap-1">
      {options.map((option) => (
        <label key={option[0]} className="d-flex align-items-center gap-2 m-0">
          <input type="checkbox" className="form-check-input m-0" checked={ids.has(option[0])} disabled={readonly} onChange={() => toggle(option)} />{option[1]}
        </label>
      ))}
    </div>
  );
}

/** many2one_avatar(_user): avatar bubble before the name. */
export function Many2OneAvatarField(props: FieldProps & { editor: React.ReactNode }) {
  const name = nameOf(props.value);
  return (
    <div className="o_field_widget d-flex align-items-center gap-2">
      {name && <span className="o_avatar" style={{ background: avatarColor(name), width: 20, height: 20, fontSize: 11 }}>{name.slice(0, 1).toUpperCase()}</span>}
      {props.readonly ? <span>{name}</span> : <div className="flex-grow-1">{props.editor}</div>}
    </div>
  );
}

/** Statinfo / percentpie / handle and other purely decorative widgets fall through to text. */
export function PercentPieField({ value }: FieldProps) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="o_field_widget d-flex align-items-center gap-2">
      <span className="rounded-circle d-inline-block" style={{ width: 28, height: 28, background: `conic-gradient(var(--o-brand-primary) ${percent}%, var(--o-gray-200) 0)` }} />
      <span>{Math.round(percent)}%</span>
    </div>
  );
}

/** badges_many2one: the first N comodel records as pill buttons (activity types), with their icon. */
export function BadgesMany2OneField(props: FieldProps & { editor: React.ReactNode }) {
  const { field, node, value, readonly, onChange } = props;
  const [items, setItems] = useState<{ id: number; name: string; icon: string | null }[]>([]);
  const iconField = /'related_icon_field'\s*:\s*'(\w+)'/.exec(node.options ?? '')?.[1];
  const limit = Number(/'badge_limit'\s*:\s*(\d+)/.exec(node.options ?? '')?.[1] ?? 8);
  useEffect(() => {
    if (!field.relation) return;
    let cancelled = false;
    rpc<Record<string, unknown>[]>('searchRead', field.relation, { domain: [], fields: iconField ? ['display_name', iconField] : ['display_name'], limit, order: 'sequence asc, id asc' }, { silent: true })
      .then((rows) => { if (!cancelled) setItems(rows.map((row) => ({ id: row.id as number, name: String(row.display_name ?? ''), icon: iconField && typeof row[iconField] === 'string' ? String(row[iconField]) : null }))); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [field.relation, iconField, limit]);
  const current = idOf(value);
  const inList = items.some((item) => item.id === current);
  return (
    <div className="o_field_widget d-flex flex-wrap align-items-center gap-2">
      {items.map((item) => (
        <button key={item.id} type="button" className={`btn btn-sm rounded-pill ${item.id === current ? 'btn-primary' : 'btn-outline-secondary'}`} disabled={readonly}
          onClick={() => onChange({ id: item.id, display_name: item.name })}>
          {item.icon && <i className={`fa ${item.icon} me-1`} />}{item.name}
        </button>
      ))}
      {(!inList || items.length === 0) && <div style={{ minWidth: 160 }}>{props.editor}</div>}
    </div>
  );
}

/**
 * Date / datetime: a text input showing the localised value, a calendar
 * button that opens the native picker, and lenient typed input
 * (`2026-09-20`, `09/20/2026`, `20/09/2026` by language, `20/9`, `+3` days).
 */
export function DatePickerField({ field, value, readonly, required, onChange, node, record }: FieldProps) {
  const lang = useLang();
  const t = useT();
  const currencies = useCurrencies();
  const isDatetime = field.type === 'datetime';
  const picker = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const text = formatValue(field, value, { lang, record, currencies });
  if (readonly) return <span className="o_field_widget o_readonly">{text}</span>;

  const raw = value === false || value == null ? '' : String(value);
  const nativeValue = isDatetime ? raw.replace(' ', 'T').slice(0, 16) : raw.slice(0, 10);
  const commit = (typed: string) => {
    setDraft(null);
    const parsed = parseTypedDate(typed.trim(), lang, isDatetime, raw);
    if (parsed === undefined) return;
    onChange(parsed);
  };
  return (
    <div className="o_field_widget o_field_date d-flex align-items-center">
      <input className="o_input" value={draft ?? text} placeholder={t(node.placeholder) || (isDatetime ? `${lang === 'ar_001' ? 'DD/MM/YYYY' : 'MM/DD/YYYY'} HH:MM` : lang === 'ar_001' ? 'DD/MM/YYYY' : 'MM/DD/YYYY')} required={required}
        onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit((event.target as HTMLInputElement).value); } if (event.key === 'Escape') setDraft(null); }} />
      <button type="button" className="btn btn-link btn-sm text-muted p-0 ms-1" tabIndex={-1} aria-label={t('Pick a date')}
        onClick={() => { const input = picker.current; if (!input) return; if ('showPicker' in input) { try { (input as HTMLInputElement & { showPicker: () => void }).showPicker(); return; } catch { /* fall through */ } } input.click(); }}>
        <i className="fa fa-calendar" />
      </button>
      <input ref={picker} type={isDatetime ? 'datetime-local' : 'date'} value={nativeValue} tabIndex={-1} aria-hidden="true"
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        onChange={(event) => { const next = event.target.value; if (!next) return onChange(false); onChange(isDatetime ? `${next.replace('T', ' ')}:00`.slice(0, 19) : next); }} />
    </div>
  );
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

/** Typed text → ISO value (`undefined` = leave unchanged, `false` = cleared). */
export function parseTypedDate(text: string, lang: string, isDatetime: boolean, current: string): string | false | undefined {
  if (!text) return false;
  const today = new Date();
  let year = today.getFullYear(); let month = today.getMonth() + 1; let day = today.getDate();
  let time = current.length > 10 ? current.slice(11, 16) : '00:00';
  const relative = /^([+-]\d+)([dwm]?)$/i.exec(text);
  const timeMatch = /(\d{1,2}):(\d{2})/.exec(text);
  if (timeMatch) time = `${pad(Number(timeMatch[1]))}:${timeMatch[2]}`;
  const datePart = text.replace(/\d{1,2}:\d{2}(:\d{2})?\s*([ap]m)?/i, '').trim();
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const base = new Date(today);
    if (unit === 'w') base.setDate(base.getDate() + n * 7); else if (unit === 'm') base.setMonth(base.getMonth() + n); else base.setDate(base.getDate() + n);
    year = base.getFullYear(); month = base.getMonth() + 1; day = base.getDate();
  } else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(datePart)) {
    [year, month, day] = datePart.split('-').map(Number);
  } else if (/^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?$/.test(datePart)) {
    const parts = datePart.split(/[/.-]/).map(Number);
    const dayFirst = lang === 'ar_001';
    day = dayFirst ? parts[0] : parts[1]; month = dayFirst ? parts[1] : parts[0];
    if (parts[2] !== undefined) year = parts[2] < 100 ? 2000 + parts[2] : parts[2];
  } else if (datePart) {
    return undefined;
  }
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime()) || date.getMonth() + 1 !== month) return undefined;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return isDatetime ? `${iso} ${time}:00` : iso;
}

/** `account-tax-totals-field`: Untaxed Amount / Taxes / Total from the record's amounts. */
export function TaxTotalsField({ record, field }: FieldProps) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const money = (name: string) => formatValue({ ...field, name, type: 'monetary', currencyField: 'currency_id' }, record[name], { lang, record, currencies });
  const rows: [string, string][] = [];
  if ('amount_untaxed' in record) rows.push([t('Untaxed Amount'), money('amount_untaxed')]);
  if ('amount_tax' in record) rows.push([t('Taxes'), money('amount_tax')]);
  if ('amount_total' in record) rows.push([t('Total'), money('amount_total')]);
  if (rows.length === 0) return null;
  return (
    <table className="o_tax_totals ms-auto">
      <tbody>
        {rows.map(([label, amount], index) => (
          <tr key={label} className={index === rows.length - 1 ? 'o_tax_totals_total' : ''}>
            <td className="text-end pe-4 text-muted">{label}</td>
            <td className="text-end fw-bold">{amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
