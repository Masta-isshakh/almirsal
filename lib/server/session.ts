import { createHmac, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cookies } from 'next/headers';
import type { Lang } from '@engine/i18n/types';
import { Environment } from '@engine/orm/env';
import { getDatabase } from './db';
import { getRegistry } from './registry';

/**
 * Who is calling. Two identity sources:
 *
 *  - Cognito (production): the Amplify Next.js adapter reads the auth cookies
 *    and the id token's email is matched to `res_users.login`.
 *  - Local session cookie (development / sandbox without Cognito): an HMAC-
 *    signed `{uid}` set by `/api/auth/login` after a password check.
 *
 * Either way the result is a `SessionUser` and an ORM `Environment` bound to
 * that user's language, timezone, companies and groups.
 */

export interface SessionUser {
  uid: number;
  login: string;
  name: string;
  partnerId: number | null;
  lang: Lang;
  tz: string;
  companyIds: number[];
  currentCompanyId: number;
  groupIds: number[];
  isAdmin: boolean;
}

const SESSION_COOKIE = 'rodeo_session';
const LANG_COOKIE = 'rodeo_lang';
const secret = () => process.env.RODEO_SESSION_SECRET ?? 'rodeo-dev-secret-change-me';

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function encodeSession(uid: number): string {
  const payload = Buffer.from(JSON.stringify({ uid, at: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): number | null {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { uid: number; at: number };
    // 30-day sessions, like Odoo's default.
    if (Date.now() - parsed.at > 30 * 86400 * 1000) return null;
    return parsed.uid;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * Passwords (local auth): scrypt with a per-user salt.
 * ---------------------------------------------------------------- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/* ---------------------------------------------------------------- *
 * Cognito
 * ---------------------------------------------------------------- */

function amplifyOutputs(): Record<string, unknown> | null {
  const path = resolve(process.cwd(), 'amplify_outputs.json');
  if (!existsSync(path)) return null;
  try {
    const outputs = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return outputs.auth ? outputs : null;
  } catch {
    return null;
  }
}

export function cognitoConfigured(): boolean {
  return amplifyOutputs() !== null;
}

/**
 * The part of amplify_outputs.json the browser needs to sign in (user pool,
 * client id, region). Database ARNs and the like stay server-side.
 */
export function clientAuthConfig(): Record<string, unknown> | null {
  const outputs = amplifyOutputs();
  if (!outputs) return null;
  return { version: outputs.version ?? '1', auth: outputs.auth };
}

async function cognitoEmail(): Promise<string | null> {
  const outputs = amplifyOutputs();
  if (!outputs) return null;
  try {
    const { createServerRunner } = await import('@aws-amplify/adapter-nextjs');
    const { fetchAuthSession } = await import('aws-amplify/auth/server');
    const { runWithAmplifyServerContext } = createServerRunner({ config: outputs as never });
    const session = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => fetchAuthSession(contextSpec),
    });
    const email = session.tokens?.idToken?.payload.email;
    return typeof email === 'string' ? email : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * Session resolution
 * ---------------------------------------------------------------- */

interface UserRow extends Record<string, unknown> {
  id: number; login: string; name: string | null; partner_id: number | null;
  lang: string | null; tz: string | null; company_id: number | null; active: boolean | null;
}

/**
 * The resolved user is cached for a short while: every RPC call resolves
 * the session, and over the Data API the three queries behind it cost more
 * than most of the calls they guard. Writes to users/groups clear it.
 */
const USER_CACHE = new Map<string, { user: SessionUser | null; at: number }>();
const USER_TTL_MS = 30_000;

export function invalidateSessionCache(): void {
  USER_CACHE.clear();
}

async function loadUser(where: string, param: string | number): Promise<SessionUser | null> {
  const key = `${where}:${param}`;
  const cached = USER_CACHE.get(key);
  if (cached && Date.now() - cached.at < USER_TTL_MS) return cached.user;
  const user = await queryUser(where, param);
  USER_CACHE.set(key, { user, at: Date.now() });
  return user;
}

async function queryUser(where: string, param: string | number): Promise<SessionUser | null> {
  const db = await getDatabase();
  const registry = getRegistry();
  const result = await db.query<UserRow>(
    `SELECT u.id, u.login, p.name, u.partner_id, u.lang, u.tz, u.company_id, u.active
     FROM res_users u LEFT JOIN res_partner p ON p.id = u.partner_id WHERE ${where} LIMIT 1`, [param],
  );
  const row = result.rows[0];
  if (!row || row.active === false) return null;

  const companies = registry.models['res.users'].fields.company_ids;
  const companyRows = companies?.m2mTable
    ? await db.query<{ c: number }>(`SELECT "${companies.m2mColumn2}" AS c FROM "${companies.m2mTable}" WHERE "${companies.m2mColumn1}" = $1`, [row.id])
    : { rows: [] as { c: number }[] };
  const companyIds = companyRows.rows.map((r) => Number(r.c));
  const current = row.company_id ? Number(row.company_id) : (companyIds[0] ?? 1);
  if (!companyIds.includes(current)) companyIds.unshift(current);

  const groups = registry.models['res.users'].fields.group_ids;
  let groupIds: number[] = [];
  if (groups?.m2mTable) {
    const direct = await db.query<{ g: number }>(`SELECT "${groups.m2mColumn2}" AS g FROM "${groups.m2mTable}" WHERE "${groups.m2mColumn1}" = $1`, [row.id]);
    groupIds = direct.rows.map((r) => Number(r.g));
    const implied = registry.models['res.groups'].fields.implied_ids;
    if (implied?.m2mTable && groupIds.length) {
      const closure = await db.query<{ g: number }>(
        `WITH RECURSIVE tree AS (SELECT "id" FROM res_groups WHERE "id" = ANY($1)
           UNION SELECT r."${implied.m2mColumn2}" FROM "${implied.m2mTable}" r JOIN tree t ON r."${implied.m2mColumn1}" = t."id")
         SELECT "id" AS g FROM tree`, [groupIds],
      );
      groupIds = [...new Set(closure.rows.map((r) => Number(r.g)))];
    }
  }

  return {
    uid: Number(row.id),
    login: row.login,
    name: row.name ?? row.login,
    partnerId: row.partner_id == null ? null : Number(row.partner_id),
    lang: row.lang === 'ar_001' ? 'ar_001' : 'en_US',
    tz: row.tz ?? 'Asia/Riyadh',
    companyIds: [current, ...companyIds.filter((id) => id !== current)],
    currentCompanyId: current,
    groupIds,
    isAdmin: Number(row.id) === 2 || groupIds.length === 0,
  };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const uid = decodeSession(jar.get(SESSION_COOKIE)?.value);
  if (uid) return loadUser('u.id = $1', uid);
  const email = await cognitoEmail();
  if (email) return loadUser('lower(u.login) = lower($1)', email);
  return null;
}

/** Language for this request: the cookie override wins over the user's setting. */
export async function getRequestLang(user: SessionUser | null): Promise<Lang> {
  const jar = await cookies();
  const cookie = jar.get(LANG_COOKIE)?.value;
  if (cookie === 'ar_001' || cookie === 'en_US') return cookie;
  return user?.lang ?? 'en_US';
}

export async function getEnvironment(user: SessionUser, lang?: Lang): Promise<Environment> {
  return new Environment({
    registry: getRegistry(),
    db: await getDatabase(),
    uid: user.uid,
    lang: lang ?? user.lang,
    tz: user.tz,
    companyIds: user.companyIds,
    groupIds: user.groupIds,
    superuser: false,
  });
}

export { SESSION_COOKIE, LANG_COOKIE };
