import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Registry } from '@engine/registry/types';
import { loadRegistry, type ExtraModels, type RawSpec } from '@engine/registry/spec-loader';

/**
 * The registry is loaded once per server process from the export files.
 * ~4 MB of JSON parsed at cold start; every request after that is a lookup.
 */
let cached: Registry | undefined;

export function getRegistry(): Registry {
  if (cached) return cached;
  const root = process.cwd();
  const spec = JSON.parse(readFileSync(resolve(root, 'registry/odoo_spec.json'), 'utf8')) as RawSpec;
  const extra = JSON.parse(readFileSync(resolve(root, 'registry/extra-models.json'), 'utf8')) as ExtraModels;
  cached = loadRegistry(spec, extra);
  return cached;
}
