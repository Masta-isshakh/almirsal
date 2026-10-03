import type { Environment } from '@engine/orm/env';
import { portalToken, portalUrl } from '@/packages/apps/common';
import { getPublicEnvironment } from './public';
import { getRegistry } from './registry';

/**
 * The customer portal: a quotation or an invoice reached by a link that carries
 * its own token, the way Odoo's `/my/orders/<id>?access_token=…` works. Nobody
 * signs in — the token *is* the permission — so everything here runs as the
 * superuser on exactly one record and reads only what the document shows.
 *
 * Authentication is untouched: no session is created, read or invalidated by
 * this path. A signed-in employee following the same link sees the same page.
 */

export type PortalKind = 'orders' | 'invoices';

export interface PortalTarget { kind: PortalKind; model: 'sale.order' | 'account.move' }

const TARGETS: Record<PortalKind, PortalTarget['model']> = { orders: 'sale.order', invoices: 'account.move' };

/** Equal-length comparison that does not stop at the first different byte. */
export function tokenMatches(expected: string, given: string): boolean {
  if (!expected || !given || expected.length !== given.length) return false;
  let same = 0;
  for (let i = 0; i < expected.length; i += 1) same |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return same === 0;
}

export { portalToken as ensurePortalToken, portalUrl };

/**
 * Open a portal request: the record named by the link, but only when the link
 * carries the record's own token. A missing or wrong token is refused even for
 * a record that exists, so the id in the URL tells a visitor nothing.
 */
export async function openPortalRecord(kind: string, idText: string, token: string | null, lang: 'en_US' | 'ar_001' = 'en_US'): Promise<{ env: Environment; model: PortalTarget['model']; id: number } | { error: 404 | 403 }> {
  const model = TARGETS[kind as PortalKind];
  const id = Number(idText);
  if (!model || !Number.isInteger(id) || id <= 0) return { error: 404 };
  if (!getRegistry().models[model]) return { error: 404 };

  // The same environment the kiosk and the cron use: no session is read or
  // written here, so nothing about signing in is involved.
  const env = await getPublicEnvironment(lang);
  const [row] = await env.model(model).read(id, ['access_token']).catch(() => []);
  // A record that is not there and a token that does not match answer alike:
  // the id in the link must not tell a visitor whether it exists.
  if (!row || !token || !tokenMatches(String(row.access_token ?? ''), token)) return { error: 403 };
  return { env, model, id };
}

/**
 * The language a public page answers in: what the link asks for, else the
 * partner's own language, else what the browser asks for. Odoo writes to a
 * customer in the language on their contact, and so does this.
 */
export async function portalLang(env: Environment | null, partnerId: number | null, url: URL, request: Request): Promise<'en_US' | 'ar_001'> {
  const asked = url.searchParams.get('lang');
  if (asked === 'ar_001' || asked === 'en_US') return asked;
  if (env && partnerId) {
    const [partner] = await env.model('res.partner').read(partnerId, ['lang']).catch(() => []);
    // An unset selection reads as `false`, which is not a language.
    const lang = typeof partner?.lang === 'string' ? partner.lang : '';
    if (lang.startsWith('ar')) return 'ar_001';
    if (lang) return 'en_US';
  }
  // `ar`, `ar-SA`, `ar;q=0.9` — but not a language that merely starts with it.
  return /(^|,)\s*ar(?![a-z])/i.test(request.headers.get('accept-language') ?? '') ? 'ar_001' : 'en_US';
}
