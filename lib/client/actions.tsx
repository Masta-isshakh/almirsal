'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { ActionDef, FieldDef, ViewDef, ViewType } from '@engine/registry/types';
import { rpc } from './rpc';
import { useNavigation } from './navigation';
import { useUi } from '@/components/webclient/ui';
import { ActionDialog } from '@/components/webclient/ActionDialog';
import { Composer } from '@/components/webclient/Composer';

/**
 * The action manager's `doAction` (A-4 §1, C-4): runs whatever a menu,
 * button or server method hands back —
 *
 *  - a registry action id / slug              → loaded, then routed
 *  - `act_window` with `target: 'new'`         → wizard in a dialog
 *  - `act_window` with `target: 'current'`     → navigation (`/odoo/<slug>/<id>`)
 *  - an ad-hoc `act_window` from a method      → best matching registry
 *                                                action, else `/odoo/m/<model>`
 *  - `ir.actions.act_window_close`             → close the dialog, reload
 *  - `ir.actions.client` display_notification  → toast
 *  - `ir.actions.act_url`                       → new tab
 */

export interface ActionDescription {
  action: ActionDef;
  views: Partial<Record<ViewType, ViewDef>>;
  searchView: ViewDef | null;
  fields: Record<string, FieldDef>;
  relatedFields: Record<string, Record<string, FieldDef>>;
  slug: string;
}

export interface DoActionOptions {
  activeId?: number;
  activeIds?: number[];
  activeModel?: string;
  context?: Record<string, unknown>;
  /** Called when a dialog action finishes (`changed` = something was saved/run). */
  onClose?: (changed: boolean) => void;
}

/** Action names arrive as `{en, ar}` from hooks or as plain strings. */
function i18nName(value: unknown): { en: string; ar: string } {
  if (value && typeof value === 'object' && 'en' in (value as object)) { const v = value as { en: string; ar?: string }; return { en: v.en, ar: v.ar ?? v.en }; }
  return { en: String(value ?? ''), ar: String(value ?? '') };
}

export type ActionLike = number | string | ActionDef | Record<string, unknown> | false | null | undefined;

interface ActionRunner {
  doAction: (action: ActionLike, options?: DoActionOptions) => Promise<void>;
}

const ActionContext = createContext<ActionRunner | null>(null);

function idsQuery(domain: unknown): string {
  if (!Array.isArray(domain)) return '';
  const leaf = domain.find((item) => Array.isArray(item) && item[0] === 'id' && item[1] === 'in');
  return leaf && Array.isArray(leaf[2]) ? `?ids=${(leaf[2] as number[]).join(',')}` : '';
}

export function ActionRunnerProvider({ children }: { children: ReactNode }) {
  const { navigate } = useNavigation();
  const ui = useUi();

  const doAction = useCallback(async (raw: ActionLike, options: DoActionOptions = {}): Promise<void> => {
    if (!raw) return;
    const baseContext: Record<string, unknown> = {
      ...(options.context ?? {}),
      ...(options.activeId ? { active_id: options.activeId, active_ids: options.activeIds ?? [options.activeId], active_model: options.activeModel } : {}),
    };

    // Registry action by id or slug.
    if (typeof raw === 'number' || typeof raw === 'string' || (typeof raw === 'object' && 'xmlId' in raw)) {
      const key = typeof raw === 'object' ? String((raw as ActionDef).id) : String(raw);
      const description = await rpc<ActionDescription>('loadAction', null, { id: key });
      return openDescribed(description, baseContext, options);
    }

    const result = raw as Record<string, unknown>;
    const type = String(result.type ?? '');

    if (type === 'ir.actions.act_window_close') { options.onClose?.(true); return; }
    if (type === 'ir.actions.client' && result.tag === 'display_notification') {
      const params = (result.params ?? {}) as { title?: string; message?: string; type?: 'success' | 'warning' | 'danger' | 'info'; sticky?: boolean };
      ui.notify({ title: params.title, message: params.message ?? '', type: params.type ?? 'info', sticky: params.sticky });
      options.onClose?.(true);
      return;
    }
    if (type === 'ir.actions.client' && result.tag === 'mail.compose') {
      const params = (result.params ?? {}) as { model?: string; res_id?: number };
      const model = params.model ?? options.activeModel ?? '';
      const resId = Number(params.res_id ?? options.activeId ?? 0);
      let dialogId = 0;
      dialogId = ui.openDialog({
        title: { en: 'Send by Email', ar: 'إرسال عبر البريد الإلكتروني' }, size: 'lg', footer: null,
        body: <Composer model={model} resId={resId} onDone={(sent) => { ui.closeDialog(dialogId); options.onClose?.(sent); }} />,
      });
      return;
    }
    if (type === 'ir.actions.client' && result.tag === 'reload') { options.onClose?.(true); window.location.reload(); return; }
    if (type === 'ir.actions.act_url') {
      window.open(String(result.url), result.target === 'self' ? '_self' : '_blank');
      return;
    }
    if (type === 'ir.actions.report') {
      const ctx = (result.context as Record<string, unknown>) ?? {};
      const ids = options.activeIds?.length ? options.activeIds : Array.isArray(ctx.active_ids) ? (ctx.active_ids as number[]) : options.activeId ? [options.activeId] : [];
      if (ids.length === 0) { ui.notify({ message: { en: 'Select records first.', ar: 'حدد السجلات أولاً.' }, type: 'warning' }); return; }
      window.open(`/report/${encodeURIComponent(String(result.report_name))}/${ids.join(',')}${result.print === false ? '' : '?print=1'}`, '_blank');
      options.onClose?.(true);
      return;
    }
    if (type === 'ir.actions.act_window' || result.res_model) {
      if (result.id && typeof result.id !== 'string') {
        const description = await rpc<ActionDescription>('loadAction', null, { id: String(result.id) });
        return openDescribed(description, { ...baseContext, ...((result.context as Record<string, unknown>) ?? {}) }, options, result);
      }
      const model = String(result.res_model);
      const context = { ...baseContext, ...((result.context as Record<string, unknown>) ?? {}) };
      if (result.target === 'new') {
        const described = await rpc<Omit<ActionDescription, 'action' | 'slug'>>('loadModelViews', model, { viewTypes: ['form'] });
        openDialog({ ...described, action: { id: `m:${model}`, xmlId: '', type: 'act_window', name: i18nName(result.name), model, target: 'new' }, slug: `m/${model}` }, context, options);
        return;
      }
      const found = await rpc<ActionDescription | null>('findAction', model, { context });
      const slug = found?.slug ?? `m/${model}`;
      const resId = result.res_id ? Number(result.res_id) : null;
      options.onClose?.(true);
      navigate(resId ? `/odoo/${slug}/${resId}` : `/odoo/${slug}${idsQuery(result.domain)}`);
      return;
    }
    if (type === 'ir.actions.server') {
      ui.notify({ message: 'This server action is not available yet.', type: 'warning' });
    }

    function openDescribed(description: ActionDescription, context: Record<string, unknown>, opts: DoActionOptions, override?: Record<string, unknown>): void {
      const { action } = description;
      if (action.type === 'url') { window.open(String(action.url), '_blank'); return; }
      if (action.type === 'report') {
        const ids = opts.activeIds?.length ? opts.activeIds : opts.activeId ? [opts.activeId] : [];
        if (ids.length && action.reportName) window.open(`/report/${encodeURIComponent(action.reportName)}/${ids.join(',')}?print=1`, '_blank');
        return;
      }
      if (action.type !== 'act_window') { ui.notify({ message: `Client action "${action.name.en}" is not available yet.`, type: 'warning' }); return; }
      if (action.target === 'new') { openDialog(description, context, opts); return; }
      const resId = override?.res_id ? Number(override.res_id) : null;
      opts.onClose?.(true);
      navigate(resId ? `/odoo/${description.slug}/${resId}` : `/odoo/${description.slug}${idsQuery(override?.domain)}`);
    }

    function openDialog(description: ActionDescription, context: Record<string, unknown>, opts: DoActionOptions): void {
      let dialogId = 0;
      dialogId = ui.openDialog({
        title: description.action.name,
        size: 'lg',
        footer: null,
        body: (
          <ActionDialog
            description={description}
            context={context}
            onDone={(changed) => { ui.closeDialog(dialogId); opts.onClose?.(changed); }}
          />
        ),
        onClose: () => opts.onClose?.(false),
      });
    }
  }, [navigate, ui]);

  const value = useMemo(() => ({ doAction }), [doAction]);
  return <ActionContext.Provider value={value}>{children}</ActionContext.Provider>;
}

export function useActions(): ActionRunner {
  const runner = useContext(ActionContext);
  if (!runner) throw new Error('useActions must be used inside ActionRunnerProvider');
  return runner;
}
