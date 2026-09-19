import type { Domain } from '@engine/registry/types';
import type { Environment } from '@engine/orm/env';
import { OrmError, UserError } from '@engine/orm/errors';
import type { Values } from '@engine/orm/hooks';
import type { ReadSpecification, SearchOptions } from '@engine/orm/model';
import type { ReadGroupOptions } from '@engine/orm/read-group';
import { getRegistry } from './registry';
import { postMessage } from '@engine/orm/mail';

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
}

type Handler = (env: Environment, model: string, params: Record<string, unknown>) => Promise<unknown>;

const num = (value: unknown): number => Number(value);
const ids = (value: unknown): number[] => (Array.isArray(value) ? value.map(num) : [num(value)]);

const HANDLERS: Record<string, Handler> = {
  async searchRead(env, model, p) {
    const options: SearchOptions = { offset: p.offset as number, limit: p.limit as number, order: p.order as string };
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
    const [found, length] = await Promise.all([m.search(domain, options), m.searchCount(domain)]);
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
    if (!action) throw new UserError({ en: `Unknown action ${key}`, ar: `إجراء غير معروف ${key}` });
    return action;
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
  async fieldsGet(env, model) {
    return getRegistry().models[model]?.fields ?? {};
  },
};

export async function dispatch(env: Environment, request: RpcRequest): Promise<unknown> {
  const handler = HANDLERS[request.method];
  if (!handler) throw new UserError({ en: `Unknown RPC method ${request.method}`, ar: `دالة RPC غير معروفة ${request.method}` });
  const model = request.model ?? '';
  if (model && !getRegistry().models[model]) throw new UserError({ en: `Unknown model ${model}`, ar: `نموذج غير معروف ${model}` });
  return handler(env, model, request.params ?? {});
}

export function serializeError(error: unknown): { kind: string; title: unknown; message: unknown; data?: unknown; debug?: string } {
  if (error instanceof OrmError) return error.toJSON();
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'server_error',
    title: { en: 'Server Error', ar: 'خطأ في الخادم' },
    message: { en: message, ar: message },
    debug: error instanceof Error ? error.stack : undefined,
  };
}
