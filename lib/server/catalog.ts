import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Lang } from '@engine/i18n/types';

let arabic: Record<string, string> | undefined;

/** The EN → AR catalog generated from the export (`messages/ar.json`). */
export function getCatalog(lang: Lang): Record<string, string> {
  if (lang !== 'ar_001') return {};
  if (!arabic) arabic = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/ar.json'), 'utf8')) as Record<string, string>;
  return arabic;
}
