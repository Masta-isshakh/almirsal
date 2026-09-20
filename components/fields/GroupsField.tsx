'use client';

import { useEffect, useMemo, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { idOf } from '@/lib/client/display';
import type { FieldProps } from './Field';

type Rec = Record<string, unknown>;
interface Category { id: number; name: string; sequence: number; parent: number | null }
interface Privilege { id: number; name: string; sequence: number; category: number | null }
interface Group { id: number; name: string; privilege: number | null; sequence: number }

/**
 * `res_user_group_ids` (Settings › Users › Access Rights): one section per
 * application category, a select per privilege listing its groups from the
 * lowest to the highest, and "Extra Rights" checkboxes for the groups that
 * belong to no privilege.
 */
export function GroupsField({ value, readonly, onChange }: FieldProps) {
  const t = useT();
  const lang = useLang();
  const [categories, setCategories] = useState<Category[]>([]);
  const [privileges, setPrivileges] = useState<Privilege[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  useEffect(() => {
    let cancelled = false;
    const m2o = (v: unknown) => idOf(v);
    (async () => {
      const [cats, privs, grps] = await Promise.all([
        rpc<Rec[]>('searchRead', 'ir.module.category', { domain: [], fields: ['name', 'sequence', 'parent_id'], order: 'sequence asc, name asc', limit: 500 }, { silent: true, cacheMs: 10 * 60_000 }).catch(() => []),
        rpc<Rec[]>('searchRead', 'res.groups.privilege', { domain: [], fields: ['name', 'sequence', 'category_id'], order: 'sequence asc, name asc', limit: 500 }, { silent: true, cacheMs: 10 * 60_000 }).catch(() => []),
        rpc<Rec[]>('searchRead', 'res.groups', { domain: [], fields: ['name', 'privilege_id', 'sequence'], order: 'sequence asc, id asc', limit: 1000 }, { silent: true, cacheMs: 10 * 60_000 }).catch(() => []),
      ]);
      if (cancelled) return;
      setCategories(cats.map((row) => ({ id: row.id as number, name: String(row.name), sequence: Number(row.sequence) || 0, parent: m2o(row.parent_id) })));
      setPrivileges(privs.map((row) => ({ id: row.id as number, name: String(row.name), sequence: Number(row.sequence) || 0, category: m2o(row.category_id) })));
      setGroups(grps.map((row) => ({ id: row.id as number, name: String(row.name), privilege: m2o(row.privilege_id), sequence: Number(row.sequence) || 0 })));
    })();
    return () => { cancelled = true; };
  }, [lang]);

  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const selected = useMemo(() => new Set(items.map((item) => idOf(item))), [items]);

  const setGroupIds = (next: Set<number | null>) => {
    onChange(groups.filter((group) => next.has(group.id)).map((group) => ({ id: group.id, display_name: group.name })));
  };
  const choosePrivilege = (privilege: Privilege, groupId: number | null) => {
    const next = new Set(selected);
    for (const group of groups) if (group.privilege === privilege.id) next.delete(group.id);
    if (groupId) next.add(groupId);
    setGroupIds(next);
  };
  const toggleExtra = (group: Group) => {
    const next = new Set(selected);
    if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
    setGroupIds(next);
  };

  const sections = useMemo(() => {
    const byCategory = new Map<number | null, Privilege[]>();
    for (const privilege of privileges) {
      const list = byCategory.get(privilege.category) ?? [];
      list.push(privilege);
      byCategory.set(privilege.category, list);
    }
    const ordered = categories.filter((category) => byCategory.has(category.id)).map((category) => ({ category, privileges: byCategory.get(category.id)! }));
    if (byCategory.has(null)) ordered.push({ category: { id: 0, name: 'Other', sequence: 999, parent: null }, privileges: byCategory.get(null)! });
    return ordered;
  }, [categories, privileges]);
  const extras = groups.filter((group) => group.privilege === null);

  if (!groups.length) return <div className="o_field_widget text-muted">{t('Loading...')}</div>;

  return (
    <div className="o_field_widget o_user_groups w-100">
      {sections.map(({ category, privileges: list }) => (
        <div key={category.id} className="mb-3">
          <h5 className="o_horizontal_separator mb-2">{t(category.name)}</h5>
          <div className="o_group_grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) minmax(200px, 2fr)', rowGap: 4, columnGap: 16, alignItems: 'center' }}>
            {list.map((privilege) => {
              const options = groups.filter((group) => group.privilege === privilege.id);
              const current = options.find((group) => selected.has(group.id))?.id ?? '';
              return (
                <div key={privilege.id} className="d-contents">
                  <label className="o_form_label m-0">{t(privilege.name)}</label>
                  <select className="o_input" value={current} disabled={readonly} onChange={(event) => choosePrivilege(privilege, event.target.value ? Number(event.target.value) : null)}>
                    <option value="" />
                    {options.map((group) => <option key={group.id} value={group.id}>{t(group.name)}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {extras.length > 0 && (
        <div className="mb-3">
          <h5 className="o_horizontal_separator mb-2">{t('Extra Rights')}</h5>
          <div className="row">
            {extras.map((group) => (
              <label key={group.id} className="col-12 col-md-6 d-flex align-items-center gap-2 m-0 py-1">
                <input type="checkbox" className="form-check-input m-0" checked={selected.has(group.id)} disabled={readonly} onChange={() => toggleExtra(group)} />{t(group.name)}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
