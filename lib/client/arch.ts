import type { FieldNode, FormArch, FormNode, ListArch, ViewArch } from '@engine/registry/arch';
import type { FieldDef } from '@engine/registry/types';
import type { ReadSpecification } from '@engine/orm/model';
import { evalCondition, makeScope, type EvalScope } from '@engine/expr/evaluate';
import { PyDateTime } from '@engine/expr/pydate';

/** Walk every node of a form arch. */
export function walkForm(nodes: FormNode[], visit: (node: FormNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if ('children' in node) walkForm(node.children, visit);
    if (node.kind === 'notebook') walkForm(node.pages, visit);
  }
}

/** Every field node in a form arch (including header/statusbar fields). */
export function formFields(arch: FormArch): FieldNode[] {
  const out: FieldNode[] = [];
  walkForm(arch.body, (node) => { if (node.kind === 'field') out.push(node); });
  return out;
}

/** Visible list columns: not hidden, not column_invisible, optional shown. */
export function listColumns(arch: ListArch, optionalShown?: Set<string>): FieldNode[] {
  return arch.columns.filter((column): column is FieldNode => column.kind === 'field').filter((column) => {
    if (column.hidden) return false;
    if (column.columnInvisible === true) return false;
    if (column.optional === 'hide' && !optionalShown?.has(column.name)) return false;
    if (column.optional === 'show' && optionalShown && !optionalShown.has(column.name)) return false;
    return true;
  });
}

/** Column names that participate in a list read (visible + hidden helpers). */
export function listFieldNames(arch: ListArch): string[] {
  return arch.columns.filter((column): column is FieldNode => column.kind === 'field').map((column) => column.name);
}

/**
 * Build a `web_read` specification: many2one → `{fields: {}}` (display
 * name), x2many with an embedded list → its columns, scalars → `{}`.
 */
export function specificationFor(names: string[], fields: Record<string, FieldDef>, nodes?: FieldNode[]): ReadSpecification {
  const spec: ReadSpecification = {};
  for (const name of names) {
    const field = fields[name];
    if (!field) continue;
    const node = nodes?.find((candidate) => candidate.name === name);
    if (field.type === 'many2one') {
      spec[name] = { fields: {} };
    } else if (field.type === 'one2many' || field.type === 'many2many') {
      const embedded = node?.views?.list;
      if (embedded && embedded.type === 'list') {
        const subNames = listFieldNames(embedded);
        spec[name] = { fields: specificationFor(subNames, {}, undefined) };
        // Without the comodel's field defs client-side, treat every column as scalar
        // plus display_name; many2one columns still come back as [id, name].
        const sub: ReadSpecification = {};
        for (const subName of subNames) sub[subName] = {};
        sub.display_name = {};
        spec[name] = { fields: sub, limit: 80 };
      } else {
        spec[name] = { fields: { display_name: {} }, limit: 80 };
      }
    } else {
      spec[name] = {};
    }
  }
  spec.display_name = {};
  return spec;
}

/** Wire record → values usable by the expression evaluator (m2o → id). */
export function recordScopeValues(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'id' in (value as object)) {
      out[key] = (value as { id: number }).id;
    } else if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string') {
      out[key] = value[0];
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (item && typeof item === 'object' && 'id' in (item as object) ? (item as { id: number }).id : item));
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface ScopeContext {
  uid: number;
  context?: Record<string, unknown>;
  companyIds?: number[];
  parent?: Record<string, unknown> | null;
}

export function makeRecordScope(record: Record<string, unknown>, ctx: ScopeContext): EvalScope {
  return makeScope({
    record: recordScopeValues(record),
    parent: ctx.parent ? recordScopeValues(ctx.parent) : null,
    context: ctx.context ?? {},
    uid: ctx.uid,
    allowedCompanyIds: ctx.companyIds ?? [1],
    now: PyDateTime.fromJsUtc(new Date()),
    strictNames: false,
  });
}

export function isInvisible(node: { invisible?: string | boolean }, scope: EvalScope): boolean {
  return evalCondition(node.invisible, scope, false);
}

export function isReadonly(node: { readonly?: string | boolean }, field: FieldDef | undefined, scope: EvalScope): boolean {
  if (field?.readonly === true) return true;
  return evalCondition(node.readonly, scope, false);
}

export function isRequired(node: { required?: string | boolean }, field: FieldDef | undefined, scope: EvalScope): boolean {
  if (field?.required === true) return true;
  return evalCondition(node.required, scope, false);
}

/** `decoration-*` → bootstrap text class, first matching wins for colors. */
export function decorationClasses(decorations: Record<string, string>, scope: EvalScope): string {
  const classes: string[] = [];
  for (const [kind, expr] of Object.entries(decorations)) {
    if (!evalCondition(expr, scope, false)) continue;
    if (kind === 'bf') classes.push('text-bf');
    else if (kind === 'it') classes.push('text-it');
    else classes.push(`text-${kind}`);
  }
  return classes.join(' ');
}

/** Bootstrap badge class from decorations (`text-bg-*`). */
export function badgeClass(decorations: Record<string, string>, scope: EvalScope): string {
  for (const [kind, expr] of Object.entries(decorations)) {
    if (['bf', 'it'].includes(kind)) continue;
    if (evalCondition(expr, scope, false)) return `text-bg-${kind}`;
  }
  return 'text-bg-secondary';
}

export function archOfType<T extends ViewArch['type']>(arch: ViewArch, type: T): Extract<ViewArch, { type: T }> | null {
  return arch.type === type ? (arch as Extract<ViewArch, { type: T }>) : null;
}
