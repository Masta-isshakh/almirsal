'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FormArch, FormNode, SettingsAppNode, SettingNode, SettingsBlockNode, FieldNode } from '@engine/registry/arch';
import type { FieldDef } from '@engine/registry/types';
import { useT } from '@/lib/client/i18n';
import { isInvisible } from '@/lib/client/arch';
import type { EvalScope } from '@engine/expr/evaluate';

/** Odoo module name → our app icon slug. */
const APP_ICONS: Record<string, string> = {
  general_settings: 'settings', sale_management: 'sales', sale_renting: 'rental', account: 'accounting', hr: 'employees',
  hr_attendance: 'attendances', documents: 'documents', project: 'project', planning: 'planning', calendar: 'calendar',
  purchase: 'purchase', sign: 'sign', fleet: 'fleet', helpdesk: 'helpdesk', knowledge: 'knowledge', approvals: 'approvals',
  survey: 'surveys', appointment: 'appointments', mail: 'discuss', discuss: 'discuss',
};

interface Props {
  arch: FormArch;
  fields: Record<string, FieldDef>;
  values: Record<string, unknown>;
  scope: EvalScope;
  renderNode: (node: FormNode, key: number) => ReactNode;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * C-6 Settings page: left app list, Save / Discard, live search that hides
 * non-matching settings (and empty blocks / apps), hash anchors per app,
 * setting cards with the toggle on the left and dependent fields indented.
 */
export function SettingsPage({ arch, fields, scope, renderNode, dirty, saving, onSave, onDiscard }: Props) {
  const t = useT();
  const apps = useMemo(() => arch.body.filter((node): node is SettingsAppNode => node.kind === 'app'), [arch]);
  const [active, setActive] = useState<string>(() => (typeof window !== 'undefined' && window.location.hash ? window.location.hash.slice(1) : apps[0]?.name ?? ''));
  const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);

  // Live search: DOM text of each setting card, then prune empty blocks / apps.
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const needle = query.trim().toLowerCase();
    root.querySelectorAll<HTMLElement>('.o_setting_box').forEach((box) => { box.hidden = Boolean(needle) && !(box.textContent ?? '').toLowerCase().includes(needle); });
    root.querySelectorAll<HTMLElement>('.o_settings_block').forEach((block) => { block.hidden = Boolean(needle) && !block.querySelector('.o_setting_box:not([hidden])'); });
    root.querySelectorAll<HTMLElement>('.o_settings_app').forEach((app) => { app.hidden = needle ? !app.querySelector('.o_settings_block:not([hidden])') : app.dataset.app !== active; });
  }, [query, active, apps]);

  useEffect(() => {
    const onHash = () => { if (window.location.hash) setActive(window.location.hash.slice(1)); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (name: string) => { setActive(name); setQuery(''); window.history.replaceState(null, '', `#${name}`); container.current?.scrollTo({ top: 0 }); };

  return (
    <div className="o_settings">
      <div className="o_settings_topbar">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>{saving ? t('Saving...') : t('Save')}</button>
        <button type="button" className="btn btn-secondary" onClick={onDiscard} disabled={!dirty}>{t('Discard')}</button>
        <div className="o_settings_search ms-auto">
          <i className="fa fa-search text-muted" />
          <input value={query} placeholder={t('Search...')} onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      <div className="o_settings_body">
        <nav className="o_settings_sidebar" aria-label="Settings apps">
          {apps.map((app) => (
            <button key={app.name} type="button" className={`o_settings_tab ${active === app.name && !query ? 'active' : ''}`} onClick={() => select(app.name)}>
              <img src={`/icons/apps/${APP_ICONS[app.name] ?? 'settings'}.svg`} alt="" onError={(event) => { (event.target as HTMLImageElement).style.visibility = 'hidden'; }} />
              <span>{t(app.string)}</span>
            </button>
          ))}
        </nav>
        <div className="o_settings_content" ref={container}>
          {apps.map((app) => (
            <section key={app.name} className="o_settings_app" data-app={app.name} id={app.name} hidden={app.name !== active}>
              <h2 className="o_settings_app_title">{t(app.string)}</h2>
              {app.children.map((child, index) => <SettingsNode key={index} node={child} fields={fields} scope={scope} renderNode={renderNode} />)}
            </section>
          ))}
          {apps.length === 0 && arch.body.map((node, index) => renderNode(node, index))}
        </div>
      </div>
    </div>
  );
}

function containsSettings(node: FormNode): boolean {
  if (node.kind === 'block' || node.kind === 'setting') return true;
  return 'children' in node && node.children.some(containsSettings);
}

const useTranslate = useT;

type NodeProps = { node: FormNode; fields: Record<string, FieldDef>; scope: EvalScope; renderNode: Props['renderNode'] };

function SettingsNode({ node, fields, scope, renderNode }: NodeProps): ReactNode {
  if (node.kind === 'block') return <SettingsBlock node={node} fields={fields} scope={scope} renderNode={renderNode} />;
  if (node.kind === 'setting') return <SettingBox node={node} fields={fields} scope={scope} renderNode={renderNode} />;
  // Wrapper elements around blocks / settings are walked here; leaf elements (labels, spans) render as in any form.
  if (node.kind === 'element' && containsSettings(node)) {
    if (isInvisible(node, scope)) return null;
    return <div className={node.class}>{node.text ? <span>{useTranslate()(node.text)}</span> : null}{node.children.map((child, index) => <SettingsNode key={index} node={child} fields={fields} scope={scope} renderNode={renderNode} />)}</div>;
  }
  if (node.kind === 'field' && node.hidden) return null;
  return renderNode(node, 0);
}

function SettingsBlock({ node, fields, scope, renderNode }: Omit<NodeProps, 'node'> & { node: SettingsBlockNode }) {
  const t = useT();
  if (isInvisible(node, scope)) return null;
  return (
    <div className="o_settings_block" id={node.name}>
      {node.title && <h3 className="o_settings_block_title">{t(node.title)}</h3>}
      <div className="o_settings_grid">
        {node.children.map((child, index) => <SettingsNode key={index} node={child} fields={fields} scope={scope} renderNode={renderNode} />)}
      </div>
    </div>
  );
}

function SettingBox({ node, fields, scope, renderNode }: Omit<NodeProps, 'node'> & { node: SettingNode }) {
  const t = useT();
  if (isInvisible(node, scope)) return null;
  const children = node.children;
  const first = children[0];
  const toggle = first && first.kind === 'field' && !first.hidden && fields[first.name]?.type === 'boolean' ? (first as FieldNode) : null;
  const rest = toggle ? children.slice(1) : children;
  // `title` on a setting is Odoo's tooltip, not the label.
  const title = node.string ?? (toggle ? fields[toggle.name]?.label : node.title);
  return (
    <div className="o_setting_box" id={node.id}>
      {toggle && <div className="o_setting_left">{renderNode(toggle, 0)}</div>}
      <div className="o_setting_right">
        {(title || toggle) && (
          <div className="o_setting_label" title={node.title ? t(node.title) : undefined}>
            {title ? t(title) : null}
            {node.companyDependent && <i className="fa fa-building-o text-muted ms-2" title={t('Company-specific')} />}
            {node.documentation && <a href={node.documentation.startsWith('http') ? node.documentation : `https://www.odoo.com/documentation/19.0${node.documentation}`} target="_blank" rel="noreferrer" className="ms-2 small" title={t('Documentation')}><i className="fa fa-external-link" /></a>}
          </div>
        )}
        {node.help && <div className="o_setting_help text-muted">{t(node.help)}</div>}
        <div className="o_setting_content">
          {rest.map((child, index) => <SettingsNode key={index} node={child} fields={fields} scope={scope} renderNode={renderNode} />)}
        </div>
      </div>
    </div>
  );
}
