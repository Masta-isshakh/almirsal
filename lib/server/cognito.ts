import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IdentityProvider } from '@/packages/apps/base/users';

/**
 * Cognito as the identity provider behind Settings › Users. Creating a user
 * in Rodeo calls AdminCreateUser, which emails the invitation with a
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
      const attributes = [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: name }];
      try {
        const created = await c.send(new m.AdminCreateUserCommand({
          UserPoolId: config.userPoolId, Username: email, UserAttributes: attributes, DesiredDeliveryMediums: ['EMAIL'],
        }));
        return created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value ?? created.User?.Username ?? null;
      } catch (error) {
        if ((error as { name?: string }).name !== 'UsernameExistsException') throw error;
        if (options.resend) {
          // Resend only works while the account still has its temporary password.
          const existing = await c.send(new m.AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: email }));
          if (existing.UserStatus === 'FORCE_CHANGE_PASSWORD') {
            await c.send(new m.AdminCreateUserCommand({ UserPoolId: config.userPoolId, Username: email, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }));
          } else {
            await c.send(new m.AdminResetUserPasswordCommand({ UserPoolId: config.userPoolId, Username: email }));
          }
          return existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? null;
        }
        const existing = await c.send(new m.AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: email }));
        return existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? null;
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
