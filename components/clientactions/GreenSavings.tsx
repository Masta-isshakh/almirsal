'use client';

import { useEffect, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';

/**
 * Sign › Reports › Green Savings — the export's only menu bound to an
 * `ir.actions.report` (`sign.green_savings_report`, qweb-html): what signing
 * electronically saved compared to printing every signed document for every
 * signer. Sheets = pages of the template (highest page of its sign items,
 * at least one) × signers, over the signed requests. Per-sheet factors are
 * the usual paper-calculator approximations for 80 g/m² A4 (5 g a sheet):
 * 8,333 sheets a tree, 26.5 L of water, 1.2 kg of CO₂, 0.9 kg of waste and
 * 2.9 kg of wood per kg of paper.
 */
interface Savings { documents: number; sheets: number; paperKg: number; trees: number; waterL: number; co2Kg: number; wasteKg: number; woodKg: number }

const SHEET_KG = 0.005;
const SHEETS_PER_TREE = 8333;

async function compute(): Promise<Savings> {
  const requests = await rpc<{ id: number; template_id: [number, string] | false; request_item_ids: number[] }[]>('searchRead', 'sign.request', {
    domain: [['state', '=', 'signed']], fields: ['template_id', 'request_item_ids'], limit: 10000,
  });
  const templateIds = [...new Set(requests.map((r) => (Array.isArray(r.template_id) ? r.template_id[0] : 0)).filter(Boolean))];
  const pages = new Map<number, number>();
  if (templateIds.length) {
    const items = await rpc<{ template_id: [number, string] | false; page: number }[]>('searchRead', 'sign.item', {
      domain: [['template_id', 'in', templateIds]], fields: ['template_id', 'page'], limit: 100000,
    });
    for (const item of items) {
      const id = Array.isArray(item.template_id) ? item.template_id[0] : 0;
      pages.set(id, Math.max(pages.get(id) ?? 1, Number(item.page) || 1));
    }
  }
  let sheets = 0;
  for (const request of requests) {
    const id = Array.isArray(request.template_id) ? request.template_id[0] : 0;
    sheets += (pages.get(id) ?? 1) * Math.max(1, (request.request_item_ids ?? []).length);
  }
  const paperKg = sheets * SHEET_KG;
  return { documents: requests.length, sheets, paperKg, trees: sheets / SHEETS_PER_TREE, waterL: paperKg * 26.5, co2Kg: paperKg * 1.2, wasteKg: paperKg * 0.9, woodKg: paperKg * 2.9 };
}

export function GreenSavings() {
  const t = useT();
  const lang = useLang();
  const [data, setData] = useState<Savings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { compute().then(setData).catch((e) => setError(String((e as Error).message ?? e))); }, []);
  const fmt = (value: number, digits = 1) => new Intl.NumberFormat(lang === 'ar_001' ? 'ar-EG' : 'en-US', { maximumFractionDigits: digits }).format(value);
  const cards: { icon: string; label: { en: string; ar: string }; value: string }[] = data ? [
    { icon: 'fa-file-text-o', label: { en: 'Documents signed', ar: 'مستندات موقعة' }, value: fmt(data.documents, 0) },
    { icon: 'fa-files-o', label: { en: 'Sheets of paper saved', ar: 'أوراق تم توفيرها' }, value: fmt(data.sheets, 0) },
    { icon: 'fa-tree', label: { en: 'Trees', ar: 'أشجار' }, value: fmt(data.trees, 2) },
    { icon: 'fa-tint', label: { en: 'Litres of water', ar: 'لترات من الماء' }, value: fmt(data.waterL) },
    { icon: 'fa-cloud', label: { en: 'kg of CO₂', ar: 'كجم من ثاني أكسيد الكربون' }, value: fmt(data.co2Kg) },
    { icon: 'fa-trash-o', label: { en: 'kg of waste', ar: 'كجم من النفايات' }, value: fmt(data.wasteKg) },
    { icon: 'fa-leaf', label: { en: 'kg of wood', ar: 'كجم من الخشب' }, value: fmt(data.woodKg) },
  ] : [];
  return (
    <div className="o_report_page o_green_savings container-fluid py-4">
      <div className="text-center mb-4">
        <i className="fa fa-leaf fa-3x text-success mb-2" aria-hidden="true" />
        <h1 className="fs-2 mb-1">{t({ en: 'Green Savings', ar: 'المحافظات البيئية' })}</h1>
        <p className="text-muted mb-0">{t({ en: 'What signing electronically saved compared to printing every signed document for each signer.', ar: 'ما وفّره التوقيع الإلكتروني مقارنة بطباعة كل مستند موقّع لكل موقّع.' })}</p>
      </div>
      {error && <div className="alert alert-warning mx-auto" style={{ maxWidth: 640 }}>{error}</div>}
      {!data && !error && <div className="text-center text-muted"><i className="fa fa-circle-o-notch fa-spin fa-2x" aria-hidden="true" /></div>}
      {data && (
        <div className="row g-3 justify-content-center">
          {cards.map((card) => (
            <div key={card.icon} className="col-6 col-md-4 col-xl-3">
              <div className="card h-100 text-center shadow-sm">
                <div className="card-body">
                  <i className={`fa ${card.icon} fa-2x text-success mb-2`} aria-hidden="true" />
                  <div className="fs-3 fw-bold">{card.value}</div>
                  <div className="text-muted small">{t(card.label)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {data && data.documents === 0 && (
        <p className="text-center text-muted mt-4">{t({ en: 'No signed document yet: the savings will show here once documents are signed.', ar: 'لا توجد مستندات موقّعة بعد: ستظهر المدخرات هنا عند توقيع المستندات.' })}</p>
      )}
    </div>
  );
}
