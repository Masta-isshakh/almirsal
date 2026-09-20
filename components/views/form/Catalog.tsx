'use client';

import { useEffect, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatFloat } from '@engine/format/index';

interface Selection { productId: number; qty: number; name: string; price: number }

/**
 * D-2 "Catalog": a grid of products with a search box and +/- quantity
 * controls; "Back to Quotation" hands the quantities back to the lines.
 */
export function Catalog({ existing, onDone }: { existing: { productId: number | null; qty: number; key: number }[]; onDone: (selection: Selection[]) => void }) {
  const t = useT();
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<{ id: number; name: string; default_code: string | false; lst_price: number }[]>([]);
  const [quantities, setQuantities] = useState<Record<number, number>>(() => {
    const map: Record<number, number> = {};
    for (const item of existing) if (item.productId) map[item.productId] = (map[item.productId] ?? 0) + item.qty;
    return map;
  });

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      const domain: unknown[] = query ? ['|', ['name', 'ilike', query], ['default_code', 'ilike', query]] : [];
      const rows = await rpc<{ id: number; name: string; default_code: string | false; lst_price: number }[]>('searchRead', 'product.product', {
        domain, fields: ['name', 'default_code', 'lst_price'], limit: 40, order: 'name asc',
      }, { silent: true }).catch(() => []);
      if (!cancelled) setProducts(rows);
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);

  const setQty = (id: number, qty: number) => setQuantities((map) => ({ ...map, [id]: Math.max(0, qty) }));

  return (
    <div>
      <input className="form-control mb-3" placeholder={t('Search...')} value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
      <div className="row g-2" style={{ maxHeight: 420, overflow: 'auto' }}>
        {products.map((product) => {
          const qty = quantities[product.id] ?? 0;
          return (
            <div key={product.id} className="col-12 col-md-6">
              <div className={`border rounded p-2 d-flex align-items-center gap-2 ${qty > 0 ? 'border-primary' : ''}`}>
                <div className="flex-grow-1">
                  <div className="fw-bold">{product.default_code ? `[${product.default_code}] ` : ''}{product.name}</div>
                  <div className="text-muted small">{formatFloat(product.lst_price, { decimals: 2 })}</div>
                </div>
                {qty > 0 ? (
                  <div className="d-flex align-items-center gap-1">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQty(product.id, qty - 1)}>−</button>
                    <input className="form-control form-control-sm text-center" style={{ width: 56 }} value={qty} onChange={(event) => setQty(product.id, Number(event.target.value) || 0)} />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQty(product.id, qty + 1)}>+</button>
                  </div>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setQty(product.id, 1)}>{t('Add')}</button>
                )}
              </div>
            </div>
          );
        })}
        {products.length === 0 && <div className="text-muted p-3">{t('No products found')}</div>}
      </div>
      <div className="o_dialog_footer mt-3 px-0 border-0">
        <button type="button" className="btn btn-primary" onClick={() => onDone(
          Object.entries(quantities).map(([id, qty]) => {
            const product = products.find((item) => item.id === Number(id));
            return { productId: Number(id), qty, name: product?.name ?? '', price: product?.lst_price ?? 0 };
          }),
        )}>
          <i className="fa fa-arrow-left me-1" />{t('Back to Quotation')}
        </button>
      </div>
      <span className="visually-hidden">{lang}</span>
    </div>
  );
}
