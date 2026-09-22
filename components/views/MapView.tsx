'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MapArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';

type Rec = Record<string, unknown>;

interface Props {
  arch: MapArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  context: Record<string, unknown>;
  offset: number;
  limit: number;
  onTotal: (total: number) => void;
  onOpen: (id: number) => void;
}

interface Partner { id: number; name: string; address: string; lat: number | null; lng: number | null }

/**
 * Map view (A-4 §12): records pinned by the address of their `res_partner`
 * field. The side panel lists the records (with the arch's fields) and the
 * map shows the selected record's location on OpenStreetMap — coordinates
 * when the partner is geolocated, else the address search — with a link to
 * open it in Google Maps and, when `routing` is on, the route through every
 * stop in order. No API key or paid service is involved.
 */
export function MapView({ arch, fields, model, domain, context, offset, limit, onTotal, onOpen }: Props) {
  const t = useT();
  const [records, setRecords] = useState<Rec[]>([]);
  const [partners, setPartners] = useState<Map<number, Partner>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const partnerField = arch.resPartner && fields[arch.resPartner] ? arch.resPartner : fields.partner_id ? 'partner_id' : null;

  const load = useCallback(async () => {
    setLoading(true);
    const names = [...new Set(['display_name', ...(partnerField ? [partnerField] : []), ...arch.fields.map((f) => f.name).filter((n) => fields[n])])];
    const page = await rpc<{ length: number; records: Rec[] }>('webSearchRead', model, { domain, specification: Object.fromEntries(names.map((n) => [n, {}])), offset, limit, order: typeof arch.attrs.default_order === 'string' ? arch.attrs.default_order : undefined }, { silent: true, context })
      .catch(() => ({ length: 0, records: [] as Rec[] }));
    setRecords(page.records);
    onTotal(page.length);
    const ids = [...new Set(page.records.map((r) => (partnerField ? idOf(r[partnerField]) : 0)).filter(Boolean))] as number[];
    const partnerFields = ['name', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id', 'partner_latitude', 'partner_longitude'];
    const rows = ids.length ? await rpc<Rec[]>('searchRead', 'res.partner', { domain: [['id', 'in', ids]], fields: partnerFields }, { silent: true }).catch(() => [] as Rec[]) : [];
    setPartners(new Map(rows.map((p) => [p.id as number, {
      id: p.id as number, name: String(p.name ?? ''),
      address: [p.street, p.street2, p.zip, p.city, nameOf(p.state_id), nameOf(p.country_id)].filter((v) => v && v !== false).map(String).join(', '),
      lat: typeof p.partner_latitude === 'number' && p.partner_latitude ? p.partner_latitude : null,
      lng: typeof p.partner_longitude === 'number' && p.partner_longitude ? p.partner_longitude : null,
    }])));
    setSelected((current) => current ?? (page.records[0]?.id as number) ?? null);
    setLoading(false);
  }, [arch, fields, model, JSON.stringify(domain), context, offset, limit, partnerField]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const current = records.find((r) => r.id === selected) ?? records[0];
  const partnerOf = (record: Rec | undefined) => (record && partnerField ? partners.get(idOf(record[partnerField]) ?? 0) : undefined);
  const partner = partnerOf(current);
  const embed = useMemo(() => {
    if (!partner) return null;
    if (partner.lat !== null && partner.lng !== null) {
      const d = 0.02;
      return `https://www.openstreetmap.org/export/embed.html?bbox=${partner.lng - d},${partner.lat - d},${partner.lng + d},${partner.lat + d}&layer=mapnik&marker=${partner.lat},${partner.lng}`;
    }
    return partner.address ? `https://www.google.com/maps?q=${encodeURIComponent(partner.address)}&output=embed` : null;
  }, [partner]);
  const stops = records.map((r) => partnerOf(r)).filter((p): p is Partner => Boolean(p && p.address));
  const routeUrl = arch.routing && stops.length > 1 ? `https://www.google.com/maps/dir/${stops.map((p) => encodeURIComponent(p.lat !== null && p.lng !== null ? `${p.lat},${p.lng}` : p.address)).join('/')}` : null;

  return (
    <div className="o_map_view">
      <div className="o_map_side">
        {loading && <div className="o_loading_indicator" />}
        {!loading && records.length === 0 && <div className="p-4 text-center text-muted"><i className="fa fa-map-marker fa-2x d-block mb-2 opacity-50" />{t('No records to display on the map.')}</div>}
        {routeUrl && <a className="btn btn-secondary btn-sm w-100 mb-2" href={routeUrl} target="_blank" rel="noreferrer"><i className="fa fa-road me-1" />{t('Route through all stops')}</a>}
        {records.map((record, index) => {
          const p = partnerOf(record);
          return (
            <div key={record.id as number} className={`o_map_record ${record.id === current?.id ? 'o_map_record_active' : ''}`} onClick={() => setSelected(record.id as number)}>
              <div className="d-flex align-items-center gap-2">
                <span className="o_map_pin"><i className="fa fa-map-marker" />{index + 1}</span>
                <div className="flex-grow-1 text-truncate fw-bold">{String(record.display_name ?? '')}</div>
                <button type="button" className="btn btn-link btn-sm p-0" title={t('Open')} onClick={(event) => { event.stopPropagation(); onOpen(record.id as number); }}><i className="fa fa-external-link" /></button>
              </div>
              {arch.fields.filter((f) => fields[f.name] && f.name !== partnerField).map((f) => {
                const value = record[f.name];
                if (value === false || value === null || value === undefined || value === '') return null;
                return <div key={f.name} className="small text-muted text-truncate"><span className="me-1">{t(f.string ?? fields[f.name].label)}:</span>{Array.isArray(value) ? (typeof value[0] === 'number' && typeof value[1] === 'string' ? nameOf(value) : (value as unknown[]).map((v) => nameOf(v) || String(v)).join(', ')) : nameOf(value) || String(value)}</div>;
              })}
              {p && <div className="small text-muted">{p.address || t('No address')}</div>}
            </div>
          );
        })}
      </div>
      <div className="o_map_canvas">
        {embed ? (
          <>
            <iframe title="map" src={embed} className="o_map_frame" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
            <div className="o_map_toolbar">
              <span className="fw-bold">{partner?.name}</span>
              <span className="text-muted small ms-2">{partner?.address}</span>
              <a className="btn btn-secondary btn-sm ms-auto" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(partner?.lat !== null && partner?.lng !== null && partner ? `${partner.lat},${partner.lng}` : partner?.address ?? '')}`} target="_blank" rel="noreferrer">
                <i className="fa fa-external-link me-1" />{t('Open in Google Maps')}
              </a>
            </div>
          </>
        ) : (
          <div className="o_map_placeholder">
            <i className="fa fa-map-o fa-3x mb-3 opacity-25" />
            <div>{current ? t('This record has no address to locate.') : t('Select a record to see it on the map.')}</div>
          </div>
        )}
      </div>
    </div>
  );
}
