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
  HOOKS.set(model, {
    ...existing,
    ...hooks,
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

/** Test helper. */
export function clearModelHooks(): void {
  HOOKS.clear();
}
