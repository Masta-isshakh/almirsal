/**
 * Raw SQL in the app modules that names a column the schema does not have.
 *
 * A statement like that fails, and because Postgres aborts the transaction on
 * the first error, everything after it in the same request fails too — with a
 * message ("current transaction is aborted") that says nothing about the
 * cause. Catching the error in JavaScript does not undo the abort, so these
 * have to be right.
 *
 *   npx tsx scripts/dev/sql-columns-check.mts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';

const registry = loadRegistry(
  JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8')),
  JSON.parse(readFileSync('registry/extra-models.json', 'utf8')),
);

/** Columns each table really has, including the audit ones the loader adds. */
const columns = new Map<string, Set<string>>();
for (const model of Object.values(registry.models)) {
  if (!model.table) continue;
  const names = new Set<string>(['id', 'create_uid', 'create_date', 'write_uid', 'write_date']);
  for (const field of Object.values(model.fields)) {
    if (field.sqlExpr || field.store === false) continue;
    if (['one2many', 'many2many'].includes(field.type)) continue;
    names.add(field.name);
  }
  columns.set(model.table, names);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// `SELECT a, b FROM table` and `UPDATE table SET a = …` with plain names only.
const SELECT = /SELECT\s+([\s\S]{1,400}?)\s+FROM\s+([a-z_][a-z0-9_]*)\b(?!\s+(?!WHERE|ORDER|GROUP|LIMIT|JOIN|LEFT|RIGHT|INNER|OUTER|ON|UNION|HAVING|RETURNING|FOR|AS)[a-z_])/gi;
const UPDATE = /UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([\s\S]{1,300}?)\s+WHERE/gi;
const problems: string[] = [];

for (const file of [...walk('packages/apps'), ...walk('lib/server')]) {
  const source = readFileSync(file, 'utf8');
  // A statement that only runs when the registry has the field is fine; the
  // call site says so with a marker comment.
  const guarded = source.includes('sql-columns-check: guarded');
  for (const match of source.matchAll(SELECT)) {
    const table = match[2];
    const known = columns.get(table);
    if (!known) continue;
    for (const piece of match[1].split(',')) {
      const name = piece.trim().replace(/\s+AS\s+\w+$/i, '').trim();
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue; // expressions, counts, casts
      if (!known.has(name) && !guarded) problems.push(`${file}: ${table}.${name} does not exist`);
    }
  }
  for (const match of source.matchAll(UPDATE)) {
    const table = match[1];
    const known = columns.get(table);
    if (!known) continue;
    for (const piece of match[2].split(',')) {
      const name = piece.trim().split(/\s*=/)[0].trim();
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
      if (!known.has(name)) problems.push(`${file}: ${table}.${name} does not exist (UPDATE)`);
    }
  }
}

const unique = [...new Set(problems)];
console.log(`${unique.length} raw statement(s) name a column the schema does not have`);
for (const problem of unique) console.log(`  ${problem}`);
