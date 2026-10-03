import type { I18n } from '../i18n/types.js';
import type { Domain } from '../registry/types.js';
import type { Environment } from './env.js';

/**
 * Per-model behaviour registered by the app modules (Part D). The generic
 * ORM handles storage, relations, defaults, access and tracking; everything
 * a model does beyond that — computed totals, state transitions, button
 * methods, onchange rules — is declared here and looked up by model name.
 *
 * Every hook receives the `Environment` it should use (transaction-bound).
 */

export type Values = Record<string, unknown>;

export interface ActionResult {
  type?: string;
  [key: string]: unknown;
}

export interface OnchangeResult {
  value?: Values;
  warning?: { title: I18n | string; message: I18n | string; type?: 'dialog' | 'notification' };
  domain?: Record<string, Domain>;
}

export interface ComputeHook {
  /** Fields recomputed by this hook (stored). */
  fields: string[];
  /** Field names whose change triggers a recompute. */
  depends: string[];
  /** Return the values to store for each record id. */
  compute: (env: Environment, ids: number[]) => Promise<Record<number, Values>>;
}

export interface ModelHooks {
  /** Default values applied before `default_<field>` context keys. */
  defaults?: (env: Environment) => Promise<Values> | Values;
  /** Stored computed fields, run after create/write in registration order. */
  computes?: ComputeHook[];
  /** Fields whose changes are logged in the chatter as tracking values. */
  tracked?: string[];
  /** Fields used by `name_search` besides the record name. */
  searchFields?: string[];
  /** Custom display name (e.g. "[CODE] Name"); receives the read record. */
  displayName?: (env: Environment, record: Values) => string;
  /** Columns the display name needs (keeps the lookup to those columns). */
  displayNameFields?: string[];
  /** SQL expression of the display name (alias = the model's table), so parents can inline it. */
  displayNameSql?: (alias: string) => string;
  /** Adjust values before the insert (sequence numbers, derived defaults). */
  beforeCreate?: (env: Environment, vals: Values) => Promise<Values> | Values;
  /** Adjust values before the update; return the values to write. */
  beforeWrite?: (env: Environment, ids: number[], vals: Values) => Promise<Values> | Values;
  /** Called after rows are inserted (ids in creation order). */
  onCreate?: (env: Environment, ids: number[], vals: Values[]) => Promise<void>;
  /** Called after rows are updated. */
  onWrite?: (env: Environment, ids: number[], vals: Values, previous: Values[]) => Promise<void>;
  /** Called before rows are deleted; throw to veto. */
  onUnlink?: (env: Environment, ids: number[]) => Promise<void>;
  /** Python-style constraints, run after every create/write; throw ValidationError. */
  constraints?: ((env: Environment, ids: number[]) => Promise<void>)[];
  /** Onchange rules keyed by the changed field. */
  onchange?: Record<string, (env: Environment, values: Values) => Promise<OnchangeResult> | OnchangeResult>;
  /** Button / server methods invoked through `callButton`. */
  methods?: Record<string, (env: Environment, ids: number[], context: Values) => Promise<ActionResult | void>>;
  /** Fields never copied by `copy()`. */
  noCopy?: string[];
  /** The message posted in the chatter when a record is created. */
  creationMessage?: I18n;
}

const HOOKS = new Map<string, ModelHooks>();

/** Register (or extend) the hooks of a model. Later registrations merge. */
export function registerModelHooks(model: string, hooks: ModelHooks): void {
  const existing = HOOKS.get(model);
  if (!existing) {
    HOOKS.set(model, { ...hooks });
    return;
  }
  // Two modules may both give a model defaults (its own app and the shared
  // form defaults); merging keeps both, with the later registration winning
  // per field, so registration order does not decide what a new record gets.
  const defaults = existing.defaults && hooks.defaults
    ? async (env: Environment) => ({ ...(await existing.defaults!(env)), ...(await hooks.defaults!(env)) })
    : hooks.defaults ?? existing.defaults;
  // The same is true of the lifecycle: two modules may each have something to
  // do when a record is created (an app's own rule and renting's period), so
  // both run, in registration order, the later one seeing the earlier's values.
  const beforeCreate = existing.beforeCreate && hooks.beforeCreate
    ? async (env: Environment, vals: Values) => hooks.beforeCreate!(env, await existing.beforeCreate!(env, vals))
    : hooks.beforeCreate ?? existing.beforeCreate;
  const beforeWrite = existing.beforeWrite && hooks.beforeWrite
    ? async (env: Environment, ids: number[], vals: Values) => hooks.beforeWrite!(env, ids, await existing.beforeWrite!(env, ids, vals))
    : hooks.beforeWrite ?? existing.beforeWrite;
  const onCreate = existing.onCreate && hooks.onCreate
    ? async (env: Environment, ids: number[], vals: Values[]) => { await existing.onCreate!(env, ids, vals); await hooks.onCreate!(env, ids, vals); }
    : hooks.onCreate ?? existing.onCreate;
  const onWrite = existing.onWrite && hooks.onWrite
    ? async (env: Environment, ids: number[], vals: Values, previous: Values[]) => { await existing.onWrite!(env, ids, vals, previous); await hooks.onWrite!(env, ids, vals, previous); }
    : hooks.onWrite ?? existing.onWrite;
  const onUnlink = existing.onUnlink && hooks.onUnlink
    ? async (env: Environment, ids: number[]) => { await existing.onUnlink!(env, ids); await hooks.onUnlink!(env, ids); }
    : hooks.onUnlink ?? existing.onUnlink;
  HOOKS.set(model, {
    ...existing,
    ...hooks,
    defaults,
    beforeCreate,
    beforeWrite,
    onCreate,
    onWrite,
    onUnlink,
    computes: [...(existing.computes ?? []), ...(hooks.computes ?? [])],
    tracked: [...new Set([...(existing.tracked ?? []), ...(hooks.tracked ?? [])])],
    searchFields: [...new Set([...(existing.searchFields ?? []), ...(hooks.searchFields ?? [])])],
    constraints: [...(existing.constraints ?? []), ...(hooks.constraints ?? [])],
    onchange: { ...(existing.onchange ?? {}), ...(hooks.onchange ?? {}) },
    methods: { ...(existing.methods ?? {}), ...(hooks.methods ?? {}) },
    noCopy: [...new Set([...(existing.noCopy ?? []), ...(hooks.noCopy ?? [])])],
  });
}

export function hooksFor(model: string): ModelHooks {
  return HOOKS.get(model) ?? {};
}

/**
 * Resolver for button methods no module registered explicitly (smart
 * buttons such as `action_view_invoices` that open related records). It
 * returns `undefined` when it cannot help, and the ORM raises as before.
 */
export type MethodFallback = (env: Environment, model: string, ids: number[], method: string, context: Values) => Promise<ActionResult | void | undefined>;

let fallback: MethodFallback | null = null;

export function setMethodFallback(resolver: MethodFallback | null): void {
  fallback = resolver;
}

export function methodFallback(): MethodFallback | null {
  return fallback;
}

/** Test helper. */
export function clearModelHooks(): void {
  HOOKS.clear();
}
