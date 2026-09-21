import { existsSync, readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { IdentityProvider } from '@/packages/apps/base/users';

/**
 * Cognito as the identity provider behind Settings › Users. Creating a user
 * in Almirsal calls AdminCreateUser, which emails the invitation with a
 * temporary password (the pool is invitation-only). Archiving disables the
 * account; "Send an Invitation Email" resends it.
 *
 * The user pool comes from amplify_outputs.json (written at deploy) or
 * `RODEO_USER_POOL_ID`; without either, provisioning is off and users sign
 * in with the local password login.
 */
interface PoolConfig { userPoolId: string; region: string }

function poolConfig(): PoolConfig | null {
  if (process.env.RODEO_USER_POOL_ID) return { userPoolId: process.env.RODEO_USER_POOL_ID, region: process.env.RODEO_USER_POOL_REGION ?? process.env.AWS_REGION ?? 'ap-south-1' };
  try {
    const path = resolve(process.cwd(), 'amplify_outputs.json');
    if (!existsSync(path)) return null;
    const outputs = JSON.parse(readFileSync(path, 'utf8')) as { auth?: { user_pool_id?: string; aws_region?: string } };
    if (!outputs.auth?.user_pool_id) return null;
    return { userPoolId: outputs.auth.user_pool_id, region: outputs.auth.aws_region ?? process.env.AWS_REGION ?? 'ap-south-1' };
  } catch {
    return null;
  }
}

/** A temporary password that satisfies the pool policy (upper, lower, digit, symbol, 12+). */
function temporaryPassword(): string {
  const pick = (chars: string) => chars[randomInt(chars.length)];
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; const lower = 'abcdefghijkmnpqrstuvwxyz'; const digits = '23456789'; const symbols = '!@#$%&*';
  const all = upper + lower + digits + symbols;
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols), ...Array.from({ length: 8 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i -= 1) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/** Cognito's attributes for a signed-in user (name, sub), read by the JIT provisioning. */
export async function cognitoUserAttributes(email: string): Promise<{ name?: string; sub?: string } | null> {
  const config = poolConfig();
  if (!config) return null;
  try {
    const m = await import('@aws-sdk/client-cognito-identity-provider');
    const c = new m.CognitoIdentityProviderClient({ region: config.region });
    const user = await c.send(new m.AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: email }));
    return { name: user.UserAttributes?.find((a) => a.Name === 'name')?.Value, sub: user.UserAttributes?.find((a) => a.Name === 'sub')?.Value };
  } catch { return null; }
}

export function cognitoIdentityProvider(): IdentityProvider | null {
  const config = poolConfig();
  if (!config) return null;
  let clientPromise: Promise<import('@aws-sdk/client-cognito-identity-provider').CognitoIdentityProviderClient> | undefined;
  const sdk = () => import('@aws-sdk/client-cognito-identity-provider');
  const client = () => (clientPromise ??= sdk().then((m) => new m.CognitoIdentityProviderClient({ region: config.region })));

  return {
    async invite(email, name, options) {
      const m = await sdk();
      const c = await client();
      const attributes = [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, ...(name ? [{ Name: 'name', Value: name }] : [])];
      try {
        const created = await c.send(new m.AdminCreateUserCommand({
          UserPoolId: config.userPoolId, Username: email, UserAttributes: attributes, DesiredDeliveryMediums: ['EMAIL'],
        }));
        return created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value ?? created.User?.Username ?? null;
      } catch (error) {
        if ((error as { name?: string }).name !== 'UsernameExistsException') throw error;
        const existing = await c.send(new m.AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: email }));
        const sub = existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? null;
        if (!options.resend) return sub;
        if (existing.UserStatus === 'FORCE_CHANGE_PASSWORD') {
          // Still on the temporary password: Cognito re-sends the invitation with a fresh one.
          await c.send(new m.AdminCreateUserCommand({ UserPoolId: config.userPoolId, Username: email, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }));
          return sub;
        }
        // Already confirmed: issue a new temporary password (the user must change it at
        // the next login) and hand it back so the app can mail or show it — Cognito
        // itself would only send a reset *code* here.
        const temporary = temporaryPassword();
        await c.send(new m.AdminSetUserPasswordCommand({ UserPoolId: config.userPoolId, Username: email, Password: temporary, Permanent: false }));
        return { sub, temporaryPassword: temporary };
      }
    },
    async setEnabled(email, enabled) {
      const m = await sdk();
      const c = await client();
      const Command = enabled ? m.AdminEnableUserCommand : m.AdminDisableUserCommand;
      await c.send(new Command({ UserPoolId: config.userPoolId, Username: email }));
    },
    async setPassword(email, password) {
      const m = await sdk();
      const c = await client();
      await c.send(new m.AdminSetUserPasswordCommand({ UserPoolId: config.userPoolId, Username: email, Password: password, Permanent: true }));
    },
  };
}
