'use client';

import { useEffect, useRef, useState } from 'react';
import { PyDate } from '@engine/expr/pydate';
import { daysUntil, formatDate } from '@engine/format/index';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatValue, idOf, nameOf, useCurrencies } from '@/lib/client/display';
import { avatarColor } from '../webclient/Navbar';
import { useFormRecord } from '../views/form/FormContext';
import { useUi } from '../webclient/ui';
import type { FieldProps } from './Field';

type Rec = Record<string, unknown>;

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
  // `date_dynamic_min`: an end date cannot be before the start date it names.
  const minField = /'min_date_field'\s*:\s*'([^']+)'/.exec(node.options ?? '')?.[1];
  const minValue = minField && record[minField] ? String(record[minField]).slice(0, isDatetime ? 16 : 10).replace(' ', 'T') : undefined;
  const commit = (typed: string) => {
    setDraft(null);
    const parsed = parseTypedDate(typed.trim(), lang, isDatetime, raw);
    if (parsed === undefined) return;
    if (parsed && minValue && parsed.replace(' ', 'T') < minValue) return;
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
      <input ref={picker} type={isDatetime ? 'datetime-local' : 'date'} value={nativeValue} min={minValue} tabIndex={-1} aria-hidden="true"
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

/** Odoo's `relative_date`: "3 days ago", "in 2 months". */
export function RelativeDateField({ value, field, record, node }: FieldProps) {
  const lang = useLang();
  const currencies = useCurrencies();
  if (!value) return <span className="o_field_widget o_readonly" />;
  const when = new Date(String(value).replace(' ', 'T') + (String(value).length <= 10 ? 'T00:00:00' : '') + 'Z').getTime();
  const days = Math.round((when - Date.now()) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar_001' ? 'ar' : 'en', { numeric: 'auto' });
  const text = Math.abs(days) >= 45 ? rtf.format(Math.round(days / 30), 'month')
    : Math.abs(days) >= 1 ? rtf.format(days, 'day')
    : rtf.format(Math.round((when - Date.now()) / 3_600_000), 'hour');
  return <span className="o_field_widget o_readonly" title={formatValue(field, value, { lang, widget: node.widget, record, currencies })}>{text}</span>;
}

/** A selection shown as a coloured pill, the way Odoo badges a state. */
export function SelectionBadgeField({ field, value, readonly, onChange }: FieldProps) {
  const t = useT();
  const options = field.selection ?? [];
  const current = options.find((option) => option.value === value);
  const tone = /done|posted|paid|valid|success|approved|won/i.test(String(value ?? '')) ? 'success'
    : /cancel|refused|fail|lost|blocked/i.test(String(value ?? '')) ? 'danger'
    : /draft|new|to_/i.test(String(value ?? '')) ? 'secondary' : 'info';
  if (readonly || !options.length) {
    return <span className={`badge rounded-pill text-bg-${tone}`}>{current ? t(current.label) : ''}</span>;
  }
  return (
    <select className={`o_input o_selection_badge badge rounded-pill text-bg-${tone}`} value={value === false || value == null ? '' : String(value)}
      onChange={(event) => onChange(event.target.value || false)}>
      {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{t(option.label)}</option>)}
    </select>
  );
}

/** A link that opens the record the field points at (journal entry, move line). */
export function OpenRecordField({ field, value, node }: FieldProps) {
  const t = useT();
  const id = Array.isArray(value) ? Number(value[0]) : Number(value);
  const label = Array.isArray(value) ? String(value[1] ?? '') : '';
  if (!id || !field.relation) return <span className="o_field_widget o_readonly">{label}</span>;
  return (
    <a className="o_field_widget o_open_record" href={`/odoo/m/${field.relation}/${id}`} title={t('Open')}>
      {label || `#${id}`}{node.widget === 'matching_link_widget' ? <i className="fa fa-link ms-1" aria-hidden="true" /> : null}
    </a>
  );
}

/**
 * Odoo's `payment` widget, the two panels under an invoice's total: the
 * payments already applied ("Paid on 09/30/2026") and the outstanding credits
 * that can be applied with one click. The amounts come from the payments
 * themselves rather than from the json field, so the panel is always current.
 */
export function PaymentsWidget({ node, record }: FieldProps) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const form = useFormRecord();
  const moveId = Number(record.id) || 0;
  const outstanding = node.name === 'invoice_outstanding_credits_debits_widget';
  const [rows, setRows] = useState<{ id: number; name: string; date: string; amount: number; currency: unknown }[]>([]);
  const [busy, setBusy] = useState(false);
  const partner = idOf(record.partner_id);
  const state = String(record.state ?? '');
  const residual = Number(record.amount_residual ?? 0);
  const moveType = String(record.move_type ?? '');
  // An outstanding credit is a payment of the same partner in the same
  // direction as the invoice that is not applied to an invoice yet.
  const inbound = /out_invoice|out_receipt|in_refund/.test(moveType);

  useEffect(() => {
    let alive = true;
    if (!moveId || state !== 'posted' || (outstanding && (!partner || residual <= 0))) { setRows([]); return () => { alive = false; }; }
    const domain = outstanding
      ? [['partner_id', '=', partner], ['state', 'in', ['paid', 'in_process']], ['payment_type', '=', inbound ? 'inbound' : 'outbound'], ['reconciled_invoice_ids', '=', false]]
      : [['reconciled_invoice_ids', 'in', [moveId]]];
    rpc<Record<string, unknown>[]>('searchRead', 'account.payment',
      { domain, fields: ['display_name', 'date', 'amount', 'currency_id'], limit: 10, order: 'date desc, id desc' }, { silent: true })
      .then((found) => { if (alive) setRows(found.map((row) => ({ id: Number(row.id), name: String(row.display_name ?? ''), date: String(row.date ?? ''), amount: Number(row.amount ?? 0), currency: row.currency_id }))); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [moveId, outstanding, partner, state, residual, inbound]);

  const money = (amount: number, currency: unknown) => formatValue({ name: 'amount', label: { en: 'Amount', ar: 'المبلغ' }, type: 'monetary', currencyField: 'currency_id' }, amount, { lang, record: { currency_id: currency }, currencies });
  const apply = async (paymentId: number, add: boolean) => {
    if (!form || busy) return;
    setBusy(true);
    await rpc('callButton', 'account.move', { ids: [moveId], method: add ? 'js_assign_outstanding_line' : 'js_remove_outstanding_partial', context: { payment_id: paymentId } })
      .catch(() => undefined);
    setBusy(false);
    form.reload();
  };

  if (!rows.length) return null;
  return (
    <div className={`o_payments_widget ${outstanding ? 'o_outstanding_credits' : ''}`}>
      <span className="o_payments_title text-muted">{t(outstanding ? 'Outstanding credits' : 'Payments')}</span>
      {rows.map((row) => (
        <div key={row.id} className="o_payment_line">
          <a href={`/odoo/m/account.payment/${row.id}`}>{row.name}</a>
          <span className="text-muted mx-1">{row.date ? formatDate(row.date, lang) : ''}</span>
          <span className="fw-bold">{money(row.amount, row.currency)}</span>
          {form ? (
            <button type="button" className="btn btn-link btn-sm p-0 ms-1" disabled={busy}
              title={t(outstanding ? 'Add' : 'Unreconcile')} onClick={() => void apply(row.id, outstanding)}>
              <i className={`fa ${outstanding ? 'fa-plus' : 'fa-times'}`} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** `x2many_buttons`: each linked record as a button that opens it. */
export function X2ManyButtonsField({ field, value }: FieldProps) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length || !field.relation) return null;
  return (
    <div className="o_field_widget o_x2many_buttons">
      {items.map((item, index) => {
        const id = idOf(item);
        return <a key={index} className="btn btn-sm btn-link" href={`/odoo/m/${field.relation}/${id}`}>{nameOf(item) || `#${id}`}</a>;
      })}
    </div>
  );
}

/** `analytic_distribution`: `{"3": 100}` read as "Project X 100%". */
export function AnalyticDistributionField({ value, field }: FieldProps) {
  const [names, setNames] = useState<Record<number, string>>({});
  let parsed: Record<string, number> = {};
  if (value && typeof value === 'object') parsed = value as Record<string, number>;
  else if (typeof value === 'string' && value.trim().startsWith('{')) { try { parsed = JSON.parse(value) as Record<string, number>; } catch { parsed = {}; } }
  // A key can name several accounts at once ("3,7"), one per analytic plan.
  const ids = [...new Set(Object.keys(parsed).flatMap((key) => key.split(',').map(Number)).filter(Boolean))];
  const wanted = ids.join(',');
  useEffect(() => {
    const missing = wanted.split(',').map(Number).filter((id) => id && !(id in names));
    if (!missing.length) return;
    rpc<Record<string, unknown>[]>('searchRead', field.relation ?? 'account.analytic.account', { domain: [['id', 'in', missing]], fields: ['display_name'], limit: 40 }, { silent: true })
      .then((found) => setNames((current) => ({ ...current, ...Object.fromEntries(found.map((row) => [Number(row.id), String(row.display_name ?? '')])) })))
      .catch(() => undefined);
    // `names` is written here, so the effect watches the ids instead.
  }, [wanted, field.relation]);
  const entries = Object.entries(parsed);
  if (!entries.length) return <span className="o_field_widget o_readonly" />;
  return (
    <span className="o_field_widget o_readonly">
      {entries.map(([key, percent]) => (
        <span key={key} className="badge rounded-pill text-bg-light border me-1">
          {key.split(',').map((id) => names[Number(id)] ?? `#${id}`).join(' / ')} {Math.round(Number(percent))}%
        </span>
      ))}
    </span>
  );
}

/** `activity_exception`: the warning icon Odoo shows when an activity is late. */
export function ActivityExceptionField({ value, field }: FieldProps) {
  const t = useT();
  if (!value) return <span className="o_field_widget o_readonly" />;
  const label = field.selection?.find((option) => String(option.value) === String(value))?.label;
  return <i className="fa fa-exclamation-triangle text-warning" title={t(label ?? 'Exception')} aria-hidden="true" />;
}

/** `hr_presence_status`: a coloured circle for present, absent or away. */
export function PresenceStatusField({ value, field }: FieldProps) {
  const t = useT();
  const text = String(value ?? '');
  if (!text) return <span className="o_field_widget o_readonly" />;
  const tone = /present|online/.test(text) ? 'text-success' : /absent|offline/.test(text) ? 'text-danger' : /holiday|leave/.test(text) ? 'text-warning' : 'text-muted';
  const icon = /holiday|leave/.test(text) ? 'fa-plane' : /busy|call/.test(text) ? 'fa-phone' : 'fa-circle';
  const label = field.selection?.find((option) => String(option.value) === text)?.label ?? text;
  return <i className={`fa ${icon} ${tone} o_presence_status`} title={t(label)} aria-hidden="true" />;
}

/**
 * `actionable_errors`: the banner Odoo draws above an invoice listing what
 * stands in the way — no lines, no partner, an unbalanced entry, a reference
 * another document of the same partner already uses. The field (`alerts`) is a
 * json map of codes computed in SQL, so the banner is always current; the
 * wording lives here, where it can be translated.
 */
const ALERT_TEXT: Record<string, { en: string; ar: string }> = {
  no_lines: { en: 'Add at least one line before posting this document.', ar: 'أضف بنداً واحداً على الأقل قبل ترحيل هذا المستند.' },
  no_partner: { en: 'Choose the partner this document is for.', ar: 'اختر الشريك الذي يتعلق به هذا المستند.' },
  no_invoice_date: { en: 'Set the bill date.', ar: 'حدد تاريخ الفاتورة.' },
  unbalanced: { en: 'The debit and the credit of this entry do not match.', ar: 'المدين والدائن في هذا القيد غير متطابقين.' },
  duplicated_ref: { en: 'Another document of this partner already uses this reference.', ar: 'مستند آخر لهذا الشريك يستخدم هذا المرجع بالفعل.' },
};

export function ActionableErrorsField({ value }: FieldProps) {
  const t = useT();
  let alerts: Record<string, { level?: string; message?: string }> = {};
  if (value && typeof value === 'object') alerts = value as Record<string, { level?: string }>;
  else if (typeof value === 'string' && value.trim().startsWith('{')) { try { alerts = JSON.parse(value); } catch { alerts = {}; } }
  const entries = Object.entries(alerts);
  if (!entries.length) return null;
  const worst = entries.some(([, alert]) => alert?.level === 'danger') ? 'danger' : 'warning';
  return (
    <div className={`alert alert-${worst} o_actionable_errors py-2 px-3 mb-2`} role="alert">
      {entries.map(([code, alert]) => (
        <div key={code} className="d-flex align-items-start gap-2">
          <i className={`fa fa-${alert?.level === 'danger' ? 'exclamation-circle' : 'exclamation-triangle'} mt-1`} aria-hidden="true" />
          <span>{alert?.message ? t(alert.message) : ALERT_TEXT[code] ? t(ALERT_TEXT[code]) : code.replace(/_/g, ' ')}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * `timezone_mismatch`: the timezone, with the warning Odoo shows when the
 * browser's offset disagrees with the one on the record — the usual cause of
 * meetings an hour out.
 */
export function TimezoneField(props: FieldProps & { editor: React.ReactNode }) {
  const { record, node, editor } = props;
  const t = useT();
  const offsetField = /'tz_offset_field'\s*:\s*'([^']+)'/.exec(node.options ?? '')?.[1] ?? 'tz_offset';
  const stored = String(record[offsetField] ?? '');
  // Odoo keeps the offset as "+0300"; the browser gives minutes behind UTC.
  const browserMinutes = -new Date().getTimezoneOffset();
  const storedMinutes = /^[+-]\d{4}$/.test(stored)
    ? (stored.startsWith('-') ? -1 : 1) * (Number(stored.slice(1, 3)) * 60 + Number(stored.slice(3, 5)))
    : null;
  const mismatch = storedMinutes !== null && storedMinutes !== browserMinutes;
  return (
    <span className="d-inline-flex align-items-center gap-1">
      {editor}
      {mismatch && (
        <i className="fa fa-exclamation-triangle text-warning" aria-hidden="true"
          title={t({ en: 'This timezone is not the one your computer is in.', ar: 'هذه المنطقة الزمنية ليست منطقة جهازك.' })} />
      )}
    </span>
  );
}

/** `shortcut`: a canned response is typed as ":hello". */
export function ShortcutField(props: FieldProps & { editor: React.ReactNode }) {
  const { value, readonly, editor } = props;
  if (!readonly) return <>{editor}</>;
  const text = value === false || value == null ? '' : String(value);
  return text ? <span className="o_shortcut badge rounded-pill text-bg-light border font-monospace">{`:${text}`}</span> : <span className="o_field_widget o_readonly" />;
}

/**
 * `additional_identifiers`: the extra company identifiers Odoo keeps as a json
 * map (a second tax id, a registration number). The list shows them; the button
 * adds one.
 */
export function IdentifiersField({ value, readonly, onChange, node }: FieldProps) {
  const t = useT();
  const ui = useUi();
  let entries: [string, unknown][] = [];
  if (value && typeof value === 'object') entries = Object.entries(value as Record<string, unknown>);
  else if (typeof value === 'string' && value.trim().startsWith('{')) { try { entries = Object.entries(JSON.parse(value)); } catch { entries = []; } }

  const add = () => {
    let name = '';
    let identifier = '';
    let dialogId = 0;
    const save = () => {
      if (name.trim()) onChange({ ...Object.fromEntries(entries), [name.trim()]: identifier.trim() });
      ui.closeDialog(dialogId);
    };
    dialogId = ui.openDialog({
      title: { en: 'Add an identifier', ar: 'إضافة معرّف' },
      size: 'sm',
      body: (
        <div className="d-flex flex-column gap-2">
          <label className="o_form_label">{t({ en: 'Name', ar: 'الاسم' })}
            <input className="o_input" autoFocus onChange={(event) => { name = event.target.value; }} />
          </label>
          <label className="o_form_label">{t({ en: 'Identifier', ar: 'المعرّف' })}
            <input className="o_input" onChange={(event) => { identifier = event.target.value; }} onKeyDown={(event) => { if (event.key === 'Enter') save(); }} />
          </label>
        </div>
      ),
      footer: (
        <>
          <button type="button" className="btn btn-primary" onClick={save}>{t('Add')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => ui.closeDialog(dialogId)}>{t('Discard')}</button>
        </>
      ),
    });
  };

  const remove = (key: string) => onChange(Object.fromEntries(entries.filter(([name]) => name !== key)));
  const isButton = (node.widget ?? '').endsWith('button');
  if (isButton) {
    return readonly ? null : (
      <button type="button" className="btn btn-link btn-sm p-0" onClick={add}>
        <i className="fa fa-plus me-1" aria-hidden="true" />{t({ en: 'Add an identifier', ar: 'إضافة معرّف' })}
      </button>
    );
  }
  if (!entries.length) return <span className="o_field_widget o_readonly text-muted">{t({ en: 'None', ar: 'لا شيء' })}</span>;
  return (
    <div className="o_field_widget o_identifiers d-flex flex-column gap-1">
      {entries.map(([name, identifier]) => (
        <span key={name} className="d-inline-flex align-items-center gap-2">
          <span className="text-muted">{name}</span>
          <span>{String(identifier ?? '')}</span>
          {!readonly && <button type="button" className="btn btn-link btn-sm p-0 text-muted" onClick={() => remove(name)} aria-label={t('Delete')}><i className="fa fa-times" /></button>}
        </span>
      ))}
    </div>
  );
}

/** `contact_statistics`: the counts Odoo prints beside a contact. */
export function StatisticsField({ value }: FieldProps) {
  const t = useT();
  let stats: Record<string, unknown> = {};
  if (value && typeof value === 'object') stats = value as Record<string, unknown>;
  else if (typeof value === 'string' && value.trim().startsWith('{')) { try { stats = JSON.parse(value); } catch { stats = {}; } }
  const entries = Object.entries(stats).filter(([, count]) => Number(count) > 0);
  if (!entries.length) return <span className="o_field_widget o_readonly" />;
  return (
    <span className="o_field_widget o_readonly">
      {entries.map(([name, count]) => (
        <span key={name} className="badge rounded-pill text-bg-light border me-1">
          {t(name.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase()))} {String(count)}
        </span>
      ))}
    </span>
  );
}

/**
 * `open_decimal_precision_button`: the warning Odoo shows when a currency is
 * rounded more finely than the decimal accuracy allows, with the way to that
 * setting.
 */
export function RoundingWarningField({ value }: FieldProps) {
  const t = useT();
  if (!value) return null;
  return (
    <div className="alert alert-warning py-1 px-2 mb-0 d-inline-flex align-items-center gap-2">
      <i className="fa fa-exclamation-triangle" aria-hidden="true" />
      <span>{t({ en: 'This rounding is finer than the decimal accuracy of prices.', ar: 'هذا التقريب أدق من الدقة العشرية للأسعار.' })}</span>
      <a className="btn btn-link btn-sm p-0" href="/odoo/m/decimal.precision">{t({ en: 'Decimal Accuracy', ar: 'الدقة العشرية' })}</a>
    </div>
  );
}

/**
 * `hr_org_chart`: the employee's place in the organisation — the managers above,
 * the colleagues beside and the direct reports below, each one a link.
 */
export function OrgChartField({ record }: FieldProps) {
  const t = useT();
  const id = Number(record.id) || 0;
  const [chart, setChart] = useState<{ managers: Rec[]; reports: Rec[]; peers: Rec[] } | null>(null);

  useEffect(() => {
    let alive = true;
    if (!id) { setChart(null); return () => { alive = false; }; }
    const load = async () => {
      const managers: Rec[] = [];
      let parent = idOf(record.parent_id);
      // Up the line, at most four levels, as Odoo draws it.
      for (let level = 0; level < 4 && parent; level += 1) {
        const [manager] = await rpc<Rec[]>('read', 'hr.employee', { ids: [parent], fields: ['display_name', 'job_title', 'parent_id'] }, { silent: true }).catch(() => []);
        if (!manager) break;
        managers.unshift(manager);
        parent = idOf(manager.parent_id);
      }
      const reports = await rpc<Rec[]>('searchRead', 'hr.employee', { domain: [['parent_id', '=', id]], fields: ['display_name', 'job_title'], limit: 20 }, { silent: true }).catch(() => []);
      const peers = idOf(record.parent_id)
        ? await rpc<Rec[]>('searchRead', 'hr.employee', { domain: [['parent_id', '=', idOf(record.parent_id)], ['id', '!=', id]], fields: ['display_name', 'job_title'], limit: 20 }, { silent: true }).catch(() => [])
        : [];
      if (alive) setChart({ managers, reports, peers });
    };
    void load();
    return () => { alive = false; };
  }, [id, record.parent_id]);

  if (!id) return null;
  const line = (employee: Rec, className = '') => (
    <a key={String(employee.id)} className={`o_org_chart_entry d-flex align-items-center gap-2 ${className}`} href={`/odoo/m/hr.employee/${employee.id}`}>
      <span className="o_avatar" style={{ width: 24, height: 24, fontSize: 11, borderRadius: '50%', background: avatarColor(String(employee.display_name ?? '')) }}>
        {String(employee.display_name ?? '').slice(0, 1)}
      </span>
      <span>{String(employee.display_name ?? '')}</span>
      {employee.job_title ? <span className="text-muted small">{String(employee.job_title)}</span> : null}
    </a>
  );
  return (
    <div className="o_org_chart">
      {chart?.managers.map((manager) => line(manager, 'o_org_chart_manager'))}
      <div className="o_org_chart_self d-flex align-items-center gap-2 fw-bold">
        <i className="fa fa-user text-muted" aria-hidden="true" />
        <span>{String(record.display_name ?? '')}</span>
      </div>
      {chart?.peers.length ? (
        <details className="o_org_chart_peers">
          <summary className="text-muted small">{t({ en: 'Colleagues', ar: 'الزملاء' })} ({chart.peers.length})</summary>
          {chart.peers.map((peer) => line(peer))}
        </details>
      ) : null}
      {chart?.reports.length ? (
        <div className="o_org_chart_reports">
          <div className="text-muted small mt-1">{t({ en: 'Direct reports', ar: 'التابعون المباشرون' })}</div>
          {chart.reports.map((report) => line(report, 'ms-3'))}
        </div>
      ) : null}
      {!chart?.managers.length && !chart?.reports.length && (
        <div className="text-muted small">{t({ en: 'No manager and no direct report yet.', ar: 'لا يوجد مدير ولا تابعون بعد.' })}</div>
      )}
    </div>
  );
}

/**
 * `resume_one2many` and `skills_one2many`: the employee's résumé and skills,
 * which Odoo shows grouped — the résumé by kind of entry, the skills by kind of
 * skill, each skill with its level.
 */
export function GroupedLinesField({ field, value, node }: FieldProps) {
  const t = useT();
  const lang = useLang();
  const ids = Array.isArray(value) ? (value as unknown[]).map((item) => idOf(item)).filter(Boolean) as number[] : [];
  const isSkills = (node.widget ?? '').startsWith('skills');
  const [rows, setRows] = useState<Rec[]>([]);
  const key = ids.join(',');

  useEffect(() => {
    if (!ids.length || !field.relation) { setRows([]); return; }
    const fieldNames = isSkills
      ? ['display_name', 'skill_type_id', 'skill_id', 'skill_level_id', 'level_progress']
      : ['display_name', 'line_type_id', 'name', 'date_start', 'date_end', 'description'];
    rpc<Rec[]>('searchRead', field.relation, { domain: [['id', 'in', ids]], fields: fieldNames, limit: 200 }, { silent: true })
      .then((found) => setRows(found))
      .catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, field.relation, isSkills]);

  if (!rows.length) return <span className="o_field_widget o_readonly text-muted">{t(isSkills ? { en: 'No skill yet.', ar: 'لا توجد مهارات بعد.' } : { en: 'No entry yet.', ar: 'لا توجد مدخلات بعد.' })}</span>;
  const groupField = isSkills ? 'skill_type_id' : 'line_type_id';
  const groups = new Map<string, Rec[]>();
  for (const row of rows) {
    const name = nameOf(row[groupField]) || t({ en: 'Other', ar: 'أخرى' });
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(row);
  }
  const period = (row: Rec) => [row.date_start, row.date_end].filter(Boolean).map((date) => formatDate(String(date), lang)).join(' — ');
  return (
    <div className="o_field_widget o_grouped_lines">
      {[...groups.entries()].map(([group, lines]) => (
        <div key={group} className="o_grouped_lines_group mb-2">
          <div className="text-muted small text-uppercase">{group}</div>
          {lines.map((row) => (
            <div key={String(row.id)} className="d-flex align-items-baseline gap-2">
              {isSkills ? (
                <>
                  <span>{nameOf(row.skill_id) || String(row.display_name ?? '')}</span>
                  <span className="badge rounded-pill text-bg-light border">{nameOf(row.skill_level_id) || `${Math.round(Number(row.level_progress ?? 0))}%`}</span>
                </>
              ) : (
                <>
                  <span className="fw-bold">{String(row.name ?? row.display_name ?? '')}</span>
                  <span className="text-muted small">{period(row)}</span>
                  {row.description ? <span className="text-muted small">{String(row.description).replace(/<[^>]+>/g, '').slice(0, 80)}</span> : null}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** `document_size`: bytes as Odoo prints them — "1.21 MB". */
export function FileSizeField({ value }: FieldProps) {
  const bytes = Number(value ?? 0);
  if (!bytes) return <span className="o_field_widget o_readonly" />;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return <span className="o_field_widget o_readonly">{`${unit === 0 ? size : size.toFixed(2)} ${units[unit]}`}</span>;
}
