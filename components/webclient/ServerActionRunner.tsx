'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActionDef, ViewType } from '@engine/registry/types';
import type { ResolvedAction } from '@/lib/server/actions';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { useActions, type ActionDescription } from '@/lib/client/actions';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from './ui';

/**
 * An `ir.actions.server` reached by URL (`/odoo/resource-bookings`): run it
 * and follow the result the way Odoo does.
 *
 * - An ad-hoc `act_window` (no action id — Resource / Staff Bookings,
 *   Certifications, the skills log…) is rendered *in place*: the server
 *   action's own path stays in the address bar and its name, domain,
 *   context and view modes drive the container, so two menus that open the
 *   same model with different domains show different records.
 * - A URL opened in a new tab leaves a card with the link (popup blockers)
 *   instead of a spinner that never ends.
 * - Anything else (a bound action, a dialog, a notification, `target:
 *   'self'` URLs) goes through the normal action runner.
 */
export function ServerActionRunner({ resolution, query, user, render }: {
  resolution: ResolvedAction; query: Record<string, string>; user: { uid: number; companyIds: number[] };
  render: (inline: ResolvedAction) => ReactNode;
}) {
  const t = useT();
  const { doAction } = useActions();
  const ui = useUi();
  const ran = useRef(false);
  const [described, setDescribed] = useState<{ action: ActionDef; views: ActionDescription['views']; searchView: ActionDescription['searchView']; fields: ActionDescription['fields']; relatedFields: ActionDescription['relatedFields'] } | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const { action } = resolution;
  void user;

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    rpc<Record<string, unknown>>('runServerAction', null, { id: String(action.id) })
      .then(async (result) => {
        const isWindow = result.type === 'ir.actions.act_window' || Boolean(result.res_model);
        if (isWindow && result.res_model && !(result.id && typeof result.id !== 'string') && result.target !== 'new' && !result.res_id) {
          const model = String(result.res_model);
          const viewMode = String(result.view_mode ?? 'list,form').split(',').map((item) => item.trim()).filter(Boolean) as ViewType[];
          const wanted = [...new Set<ViewType>([...viewMode, 'form', 'search'])];
          const views = await rpc<Omit<ActionDescription, 'action' | 'slug'>>('loadModelViews', model, { viewTypes: wanted });
          // Only the view types the model really has (a gantt asked for a
          // model without one falls through to its calendar / list).
          const available = viewMode.filter((type) => type !== 'search' && views.views[type]);
          const synthetic: ActionDef = {
            id: `srv:${action.id}`, xmlId: action.xmlId, type: 'act_window', name: i18nName(result.name) ?? action.name, model,
            viewMode: available.length ? available : (['list', 'form'] as ViewType[]).filter((type) => views.views[type]),
            domain: pySource(result.domain), context: pySource(result.context ?? {}), target: 'current', help: action.help,
          };
          setDescribed({ action: synthetic, views: views.views, searchView: views.searchView, fields: views.fields, relatedFields: views.relatedFields });
          return;
        }
        await doAction(result, {});
        if (result.type === 'ir.actions.act_url' && result.target !== 'self') setOpened(String(result.url));
      })
      .catch((error) => ui.notify({ type: 'warning', message: String((error as Error).message ?? error) }));
  }, [action, doAction, ui]);

  // Record / view state comes from the URL, like any action: `?view_type=`,
  // `/<id>` and `/new` under the server action's own path.
  const inline = useMemo<ResolvedAction | null>(() => {
    if (!described) return null;
    const requested = query.view_type as ViewType | undefined;
    const viewMode = described.action.viewMode ?? ['list', 'form'];
    let viewType: ViewType = resolution.recordId || resolution.isNew ? 'form' : requested && described.views[requested] ? requested : viewMode[0];
    if (!described.views[viewType] && viewMode.length) viewType = viewMode[0];
    return { ...resolution, ...described, viewType };
  }, [described, query.view_type, resolution]);

  if (inline) return <>{render(inline)}</>;
  if (opened) {
    return (
      <div className="o_action o_action_result p-5 text-center">
        <i className="fa fa-external-link fa-3x d-block mb-3 text-muted opacity-50" aria-hidden="true" />
        <h2 className="fs-4 mb-2">{t(action.name)}</h2>
        <p className="text-muted">{t({ en: 'Opened in a new tab. If your browser blocked it, open it from here.', ar: 'تم فتحه في تبويب جديد. إذا منعه المتصفح، افتحه من هنا.' })}</p>
        <a className="btn btn-primary" href={opened} target="_blank" rel="noreferrer">{t({ en: 'Open', ar: 'فتح' })}</a>
      </div>
    );
  }
  return (
    <div className="o_action o_action_result p-5 text-center text-muted">
      <i className="fa fa-circle-o-notch fa-spin fa-2x d-block mb-3 opacity-50" aria-hidden="true" />
      {t(action.name)}
    </div>
  );
}

/**
 * An `ir.actions.act_url` reached by URL (Discuss › Configuration › Settings
 * is `/odoo/settings#discuss_setting`): in-app URLs are followed by the
 * client router; external ones open in a new tab and leave the link here.
 * The target page picks its own app (Settings here), as Odoo does when a
 * module's Configuration menu opens the settings page.
 */
export function UrlActionPage({ action }: { action: ActionDef }) {
  const t = useT();
  const { navigate } = useNavigation();
  const url = String(action.url ?? '');
  const inApp = url.startsWith('/odoo');
  useEffect(() => {
    if (inApp) navigate(url.split('#')[0], { replace: true, app: null });
    else if (url) window.open(url, '_blank');
  }, [inApp, navigate, url]);
  if (inApp) {
    return (
      <div className="o_action o_action_result p-5 text-center text-muted">
        <i className="fa fa-circle-o-notch fa-spin fa-2x d-block mb-3 opacity-50" aria-hidden="true" />
        {t(action.name)}
      </div>
    );
  }
  return (
    <div className="o_action o_action_result p-5 text-center">
      <i className="fa fa-external-link fa-3x d-block mb-3 text-muted opacity-50" aria-hidden="true" />
      <h2 className="fs-4 mb-2">{t(action.name)}</h2>
      <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer">{t({ en: 'Open', ar: 'فتح' })}</a>
    </div>
  );
}

function i18nName(value: unknown): ActionDef['name'] | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return { en: value, ar: value };
  if (typeof value === 'object' && 'en' in (value as object)) return value as ActionDef['name'];
  return undefined;
}

/** A JSON value as Python literal source, for `ActionDef.domain` / `context` (evaluated by the expression engine). */
function pySource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const walk = (item: unknown): string => {
    if (item === null || item === undefined) return 'None';
    if (item === true) return 'True';
    if (item === false) return 'False';
    if (typeof item === 'number') return String(item);
    if (typeof item === 'string') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(walk).join(', ')}]`;
    if (typeof item === 'object') return `{${Object.entries(item as Record<string, unknown>).map(([key, entry]) => `${JSON.stringify(key)}: ${walk(entry)}`).join(', ')}}`;
    return 'None';
  };
  return walk(value);
}
