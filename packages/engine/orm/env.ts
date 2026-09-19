import type { Database, Queryable } from '../db/types.js';
import type { Lang } from '../i18n/types.js';
import type { ModelDef, Registry } from '../registry/types.js';
import { Model } from './model.js';
import { MissingError } from './errors.js';

/**
 * One `Environment` per request: who is asking (`uid`), with what context,
 * against which database handle. `withTransaction` yields a child
 * environment bound to the transaction so every nested ORM call shares it.
 */

export interface EnvironmentOptions {
  registry: Registry;
  db: Database;
  uid: number;
  context?: Record<string, unknown>;
  lang?: Lang;
  tz?: string;
  /** Companies selected in the switcher; the first is the current one. */
  companyIds?: number[];
  /** Group ids of the user, resolved once per request. */
  groupIds?: number[];
  /** True for the technical superuser (bypasses access control). */
  superuser?: boolean;
}

export class Environment {
  readonly registry: Registry;
  readonly db: Database;
  readonly cr: Queryable;
  readonly uid: number;
  readonly context: Record<string, unknown>;
  readonly lang: Lang;
  readonly tz: string;
  readonly companyIds: number[];
  readonly groupIds: number[];
  readonly superuser: boolean;
  readonly inTransaction: boolean;

  private readonly models = new Map<string, Model>();

  constructor(options: EnvironmentOptions, cr?: Queryable, inTransaction = false) {
    this.registry = options.registry;
    this.db = options.db;
    this.cr = cr ?? options.db;
    this.uid = options.uid;
    this.context = options.context ?? {};
    this.lang = options.lang ?? 'en_US';
    this.tz = options.tz ?? 'Asia/Riyadh';
    this.companyIds = options.companyIds ?? [1];
    this.groupIds = options.groupIds ?? [];
    this.superuser = options.superuser ?? false;
    this.inTransaction = inTransaction;
  }

  private get options(): EnvironmentOptions {
    return {
      registry: this.registry,
      db: this.db,
      uid: this.uid,
      context: this.context,
      lang: this.lang,
      tz: this.tz,
      companyIds: this.companyIds,
      groupIds: this.groupIds,
      superuser: this.superuser,
    };
  }

  get companyId(): number {
    return this.companyIds[0];
  }

  /** The model API for `name` (`env.model('sale.order')`). */
  model(name: string): Model {
    let model = this.models.get(name);
    if (!model) {
      const def = this.registry.models[name];
      if (!def) throw new MissingError(`Unknown model ${name}`);
      model = new Model(this, def);
      this.models.set(name, model);
    }
    return model;
  }

  modelDef(name: string): ModelDef {
    const def = this.registry.models[name];
    if (!def) throw new MissingError(`Unknown model ${name}`);
    return def;
  }

  /** A copy of this environment with a different context / user. */
  with(overrides: Partial<Pick<EnvironmentOptions, 'context' | 'uid' | 'lang' | 'companyIds' | 'superuser'>>): Environment {
    return new Environment({
      ...this.options,
      ...overrides,
      context: overrides.context ? { ...this.context, ...overrides.context } : this.context,
    }, this.cr, this.inTransaction);
  }

  /** Superuser environment (record rules and access checks bypassed). */
  sudo(): Environment {
    return this.with({ superuser: true });
  }

  /**
   * Run `fn` in a transaction. If this environment is already inside one,
   * the same transaction is reused, so nested business methods compose.
   */
  async withTransaction<T>(fn: (env: Environment) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    return this.db.transaction((tx) => fn(new Environment(this.options, tx, true)));
  }
}
