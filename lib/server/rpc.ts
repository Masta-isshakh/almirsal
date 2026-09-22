import type { Domain } from '@engine/registry/types';
import type { Environment } from '@engine/orm/env';
import { OrmError, UserError } from '@engine/orm/errors';
import type { Values } from '@engine/orm/hooks';
import type { ReadSpecification, SearchOptions } from '@engine/orm/model';
import type { ReadGroupOptions } from '@engine/orm/read-group';
import { getRegistry } from './registry';
import { describeAction, describeModel, findActionForModel, resolvePath } from './actions';
import type { ViewType } from '@engine/registry/types';
import { postMessage } from '@engine/orm/mail';
import { findReport, reportsFor } from './reports';
import { composerDefaults, mailConfigured, sendDocumentMail } from './mail';
import { computeAccountReport } from '@/packages/apps/account/reports';
import { runServerAction } from './server-actions';
import { journalDashboard } from '@/packages/apps/account/dashboard';
import { computeDashboard } from '@/packages/apps/dashboards';
import { attendanceStatus, attendanceToggle } from '@/packages/apps/hr/attendance';
import { discussChat, discussCreateChannel, discussInit, discussJoin, discussLeave, discussMarkRead, discussPoll, discussPost, discussStar, discussThread, discussUnstarAll } from './discuss';

/**
 * The RPC surface of A-4, dispatched from `/api/rpc`. Every method takes the
 * caller's `Environment` (already bound to their user, language, companies
 * and groups) and JSON params, and returns JSON. Errors are `OrmError`s,
 * serialised with their kind so the client shows the right dialog title.
 */

export interface RpcRequest {
  method: string;
  model?: string;
  params?: Record<string, unknown>;
  /** Evaluation context for this call (`default_*`, `active_id`, …). */
  context?: Record<string, unknown>;
}

type Handler = (env: Environment, model: string, params: Record<string, unknown>) => Promise<unknown>;

const num = (value: unknown): number => Number(value);
const ids = (value: unknown): number[] => (Array.isArray(value) ? value.map(num) : [num(value)]);

/**
 * Reference data that every page reads (currencies, activity types, groups,
 * …) is served from memory for a few minutes; a write to such a model
 * clears its entries. Keyed by user language because names are translated.
 */
const STATIC_MODELS = new Set(['res.currency', 'mail.activity.type', 'ir.module.category', 'res.groups.privilege', 'res.groups', 'res.lang', 'res.country', 'res.country.state', 'uom.uom', 'account.payment.method.line', 'account.journal', 'account.tax', 'product.category', 'res.partner.category', 'ir.model']);
const STATIC_TTL_MS = 5 * 60_000;
const staticCache = new Map<string, { at: number; value: unknown }>();

export function invalidateStaticCache(model?: string): void {
  for (const key of [...staticCache.keys()]) if (!model || key.startsWith(`${model}|`)) staticCache.delete(key);
}

const HANDLERS: Record<string, Handler> = {
  async searchRead(env, model, p) {
    const options: SearchOptions = { offset: p.offset as number, limit: p.limit as number, order: p.order as string };
    if (STATIC_MODELS.has(model)) {
      const key = `${model}|${env.lang}|${env.companyId}|${JSON.stringify(p)}`;
      const hit = staticCache.get(key);
      if (hit && Date.now() - hit.at < STATIC_TTL_MS) return hit.value;
      const value = await env.model(model).searchRead((p.domain as Domain) ?? [], p.fields as string[] | undefined, options);
      staticCache.set(key, { at: Date.now(), value });
      return value;
    }
    return env.model(model).searchRead((p.domain as Domain) ?? [], p.fields as string[] | undefined, options);
  },
  async search(env, model, p) {
    return env.model(model).search((p.domain as Domain) ?? [], { offset: p.offset as number, limit: p.limit as number, order: p.order as string });
  },
  async searchCount(env, model, p) {
    return env.model(model).searchCount((p.domain as Domain) ?? []);
  },
  async read(env, model, p) {
    return env.model(model).read(ids(p.ids), p.fields as string[] | undefined);
  },
  async webRead(env, model, p) {
    return env.model(model).webRead(ids(p.ids), (p.specification as ReadSpecification) ?? {});
  },
  async webSearchRead(env, model, p) {
    const m = env.model(model);
    const domain = (p.domain as Domain) ?? [];
    const options: SearchOptions = { offset: p.offset as number, limit: p.limit as number, order: p.order as string };
    const { ids: found, total: length } = await m.searchWithCount(domain, options);
    const records = await m.webRead(found, (p.specification as ReadSpecification) ?? {});
    return { length, records };
  },
  async readGroup(env, model, p) {
    return env.model(model).readGroup((p.domain as Domain) ?? [], (p.fields as string[]) ?? [], (p.groupby as string[]) ?? [], (p.options as ReadGroupOptions) ?? {});
  },
  async nameSearch(env, model, p) {
    return env.model(model).nameSearch((p.name as string) ?? '', (p.domain as Domain) ?? [], (p.operator as string) ?? 'ilike', (p.limit as number) ?? 8);
  },
  async defaultGet(env, model, p) {
    return env.model(model).defaultGet(p.fields as string[] | undefined);
  },
  async create(env, model, p) {
    return env.model(model).create(p.values as Values);
  },
  async webSave(env, model, p) {
    const m = env.model(model);
    const values = (p.values as Values) ?? {};
    const id = p.id ? num(p.id) : await m.create(values);
    if (p.id) await m.write(id, values);
    const records = await m.webRead(id, (p.specification as ReadSpecification) ?? {});
    return records[0];
  },
  async write(env, model, p) {
    return env.model(model).write(ids(p.ids), p.values as Values);
  },
  async unlink(env, model, p) {
    return env.model(model).unlink(ids(p.ids));
  },
  async copy(env, model, p) {
    return env.model(model).copy(num(p.id), (p.defaults as Values) ?? {});
  },
  async toggleActive(env, model, p) {
    return env.model(model).toggleActive(ids(p.ids));
  },
  async onchange(env, model, p) {
    return env.model(model).onchange((p.values as Values) ?? {}, (p.fields as string[]) ?? []);
  },
  async callButton(env, model, p) {
    const result = await env.model(model).callButton(ids(p.ids ?? []), String(p.method), (p.context as Values) ?? {});
    return result ?? false;
  },
  async messagePost(env, model, p) {
    const id = await postMessage(env, model, num(p.id), {
      body: String(p.body ?? ''),
      subject: p.subject as string | undefined,
      messageType: (p.isNote ? 'comment' : 'comment'),
      isInternal: Boolean(p.isNote),
      partnerIds: p.partnerIds as number[] | undefined,
    });
    return id;
  },
  async loadMenus(env) {
    const registry = getRegistry();
    return registry.menus;
  },
  async loadAction(env, _model, p) {
    const registry = getRegistry();
    const key = String(p.id ?? p.path ?? '');
    const action = registry.actions[key] ?? Object.values(registry.actions).find((a) => a.path === key || a.xmlId === key);
    if (!action) {
      // Report buttons (`sale.action_report_saleorder`) resolve to the printable document.
      const report = findReport(key);
      if (report) return { action: { id: key, xmlId: key, type: 'report', name: report.name, model: report.model, reportName: report.reportName }, views: {}, searchView: null, fields: {}, slug: `report/${report.reportName}` };
      throw new UserError({ en: `Unknown action ${key}`, ar: `إجراء غير معروف ${key}` });
    }
    return describeAction(action);
  },
  /** Views + fields for a model when a method returned an ad-hoc act_window. */
  async loadModelViews(env, model, p) {
    return describeModel(model, ((p.viewTypes as ViewType[]) ?? ['list', 'form']));
  },
  async findAction(env, model, p) {
    const action = findActionForModel(model, (p.context as Record<string, unknown>) ?? {});
    return action ? describeAction(action) : null;
  },
  async getViews(env, model, p) {
    const registry = getRegistry();
    const keys = (p.views as string[]) ?? [];
    const views: Record<string, unknown> = {};
    for (const key of keys) {
      const view = registry.views[key] ?? Object.values(registry.views).find((v) => v.model === model && v.type === key.split('|')[1]);
      if (view) views[view.type] = view;
    }
    const def = registry.models[model];
    return { views, fields: def?.fields ?? {} };
  },
  /** Composer defaults for "Send by email" on a document. */
  async composerDefaults(env, model, p) {
    return { ...(await composerDefaults(env, model, num(p.id))), configured: mailConfigured() };
  },
  /** Send the composed email, log it in the chatter, mark the document sent. */
  async sendDocument(env, model, p) {
    const result = await sendDocumentMail(env, { model, id: num(p.id), partnerIds: ids(p.partnerIds ?? []), subject: String(p.subject ?? ''), body: String(p.body ?? ''), reportName: p.reportName ? String(p.reportName) : null });
    const hooks = (await import('@engine/orm/hooks')).hooksFor(model);
    if (hooks.methods?.message_sent) await hooks.methods.message_sent(env, [num(p.id)], {});
    return result;
  },
  /** Client-side routing: the same resolution the page does on the server. */
  async resolvePath(_env, _model, p) {
    return resolvePath((p.path as string[]) ?? [], (p.query as Record<string, string>) ?? {});
  },
  /** Printable reports bound to a model (form ⚙ › Print). */
  async listReports(_env, model) {
    return reportsFor(model);
  },
  /** Financial reports (Accounting › Reporting): computed from the journal items. */
  async accountReport(env, _model, p) {
    return computeAccountReport(env, {
      reportId: Number(p.reportId), dateFrom: (p.dateFrom as string | null) ?? null, dateTo: String(p.dateTo ?? new Date().toISOString().slice(0, 10)),
      includeDraft: Boolean(p.includeDraft), journalIds: Array.isArray(p.journalIds) ? (p.journalIds as number[]) : [], partnerIds: Array.isArray(p.partnerIds) ? (p.partnerIds as number[]) : [],
      unfoldAll: Boolean(p.unfoldAll), hideZero: Boolean(p.hideZero), unfold: (p.unfold as string | null) ?? null,
      compareFrom: (p.compareFrom as string | null) ?? null, compareTo: (p.compareTo as string | null) ?? null,
    });
  },
  /* Discuss (C-8.1) */
  async discussInit(env) { return discussInit(env); },
  async discussThread(env, _model, p) { return discussThread(env, String(p.box ?? 'inbox'), p.channelId ? num(p.channelId) : undefined, p.after ? num(p.after) : undefined); },
  async discussPost(env, _model, p) { return discussPost(env, num(p.channelId), String(p.body ?? '')); },
  async discussJoin(env, _model, p) { await discussJoin(env, num(p.channelId)); return true; },
  async discussLeave(env, _model, p) { await discussLeave(env, num(p.channelId)); return true; },
  async discussCreateChannel(env, _model, p) { return discussCreateChannel(env, String(p.name ?? ''), p.type === 'group' ? 'group' : 'channel', Array.isArray(p.partnerIds) ? (p.partnerIds as number[]) : []); },
  async discussChat(env, _model, p) { return discussChat(env, num(p.partnerId)); },
  async discussStar(env, _model, p) { return discussStar(env, num(p.messageId)); },
  async discussMarkRead(env, _model, p) { await discussMarkRead(env, Array.isArray(p.notificationIds) ? (p.notificationIds as number[]) : undefined); return true; },
  async discussUnstarAll(env) { await discussUnstarAll(env); return true; },
  async discussPoll(env) { return discussPoll(env); },
  async discussAddMember(env, _model, p) {
    const exists = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM discuss_channel_member WHERE discuss_channel_id = $1 AND partner_id = $2`, [num(p.channelId), num(p.partnerId)]);
    if (!exists.rows[0]?.n) await env.sudo().model('discuss.channel.member').create({ discuss_channel_id: num(p.channelId), partner_id: num(p.partnerId) });
    return true;
  },
  /** Attendances systray (D-8): the current employee's state, and the check-in / check-out toggle. */
  async attendanceStatus(env) { return attendanceStatus(env); },
  async attendanceToggle(env, _model, p) { return attendanceToggle(env, (p.geo as { latitude?: number; longitude?: number } | undefined) ?? undefined); },
  /** Dashboards app (C-8.3): a dashboard computed from live data for a period. */
  async dashboardData(env, _model, p) { return computeDashboard(env, String(p.name ?? 'Sales'), String(p.from), String(p.to)); },
  /** Accounting dashboard cards (journals with their live numbers). */
  async journalDashboard(env, _model, p) {
    return journalDashboard(env, Array.isArray(p.ids) ? (p.ids as number[]) : undefined);
  },
  /** `ir.actions.server` bound to a menu or button. */
  async runServerAction(env, _model, p) {
    return runServerAction(env, String(p.id));
  },
  /** Per-user UI preferences (Discuss notification / call settings), kept in ir.config_parameter. */
  async getUserPrefs(env, _model, p) {
    const row = await env.cr.query<{ value: string }>(`SELECT value FROM ir_config_parameter WHERE key = $1`, [`${String(p.key)}.${env.uid}`]);
    try { return row.rows[0] ? JSON.parse(row.rows[0].value) : {}; } catch { return {}; }
  },
  async setUserPrefs(env, _model, p) {
    const key = `${String(p.key)}.${env.uid}`;
    const value = JSON.stringify(p.values ?? {});
    const updated = await env.cr.query(`UPDATE ir_config_parameter SET value = $2, write_date = now() WHERE key = $1`, [key, value]);
    if (updated.rowCount === 0) await env.cr.query(`INSERT INTO ir_config_parameter (key, value, create_date, write_date) VALUES ($1, $2, now(), now())`, [key, value]);
    return true;
  },
  async fieldsGet(env, model) {
    return getRegistry().models[model]?.fields ?? {};
  },
  /**
   * Command palette: one round trip searching the record names of the models
   * that have a menu (the current model first), 5 hits each.
   */
  async globalSearch(env, _model, p) {
    const registry = getRegistry();
    const text = String(p.name ?? '').trim();
    if (!text) return [];
    const preferred = typeof p.model === 'string' ? [p.model] : [];
    const withMenu = new Set<string>();
    for (const action of Object.values(registry.actions)) if (action.type === 'act_window' && action.model && registry.models[action.model]) withMenu.add(action.model);
    const candidates = [...preferred, ...GLOBAL_SEARCH_MODELS.filter((m) => withMenu.has(m) && !preferred.includes(m))]
      .filter((m, index, list) => registry.models[m] && list.indexOf(m) === index).slice(0, 12);
    const results = await Promise.all(candidates.map(async (model) => {
      try {
        const hits = await env.model(model).nameSearch(text, [], 'ilike', 5);
        return { model, label: registry.models[model].description ?? { en: model, ar: model }, hits };
      } catch { return { model, label: { en: model, ar: model }, hits: [] as [number, string][] }; }
    }));
    return results.filter((entry) => entry.hits.length);
  },
};

const GLOBAL_SEARCH_MODELS = [
  'res.partner', 'sale.order', 'account.move', 'product.template', 'product.product', 'purchase.order', 'project.task', 'project.project',
  'helpdesk.ticket', 'crm.lead', 'hr.employee', 'calendar.event', 'knowledge.article', 'documents.document', 'res.users', 'account.payment',
  'fleet.vehicle', 'approval.request', 'sign.request', 'survey.survey', 'planning.slot', 'hr.leave', 'sale.order.template', 'account.account',
];

const MUTATING = new Set(['create', 'write', 'unlink', 'webSave', 'callButton', 'toggleActive', 'copy']);

export async function dispatch(env: Environment, request: RpcRequest): Promise<unknown> {
  const handler = HANDLERS[request.method];
  if (!handler) throw new UserError({ en: `Unknown RPC method ${request.method}`, ar: `دالة RPC غير معروفة ${request.method}` });
  const model = request.model ?? '';
  if (model && !getRegistry().models[model]) throw new UserError({ en: `Unknown model ${model}`, ar: `نموذج غير معروف ${model}` });
  const scoped = request.context && Object.keys(request.context).length ? env.with({ context: request.context }) : env;
  if (MUTATING.has(request.method) && STATIC_MODELS.has(model)) invalidateStaticCache(model);
  return handler(scoped, model, request.params ?? {});
}

export function serializeError(error: unknown): { kind: string; title: unknown; message: unknown; data?: unknown; debug?: string } {
  if (error instanceof OrmError) return error.serialize();
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'server_error',
    title: { en: 'Server Error', ar: 'خطأ في الخادم' },
    message: { en: message, ar: message },
    debug: error instanceof Error ? error.stack : undefined,
  };
}
