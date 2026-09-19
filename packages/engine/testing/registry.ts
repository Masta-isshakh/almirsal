import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Registry } from '../registry/types.js';
import { loadRegistry, type ExtraModels, type RawSpec } from '../registry/spec-loader.js';

let cached: Registry | undefined;

/** The real registry (export + extra models), loaded once per test process. */
export function testRegistry(): Registry {
  if (cached) return cached;
  const root = process.cwd();
  const spec = JSON.parse(readFileSync(resolve(root, 'registry/odoo_spec.json'), 'utf8')) as RawSpec;
  const extra = JSON.parse(readFileSync(resolve(root, 'registry/extra-models.json'), 'utf8')) as ExtraModels;
  cached = loadRegistry(spec, extra);
  return cached;
}
