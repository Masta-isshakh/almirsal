import { clientAuthConfig, cognitoConfigured } from '@/lib/server/session';
import { ResetPasswordForm } from './ResetPasswordForm';

export const dynamic = 'force-dynamic';

/** `/web/reset_password` — forgot-password flow (Cognito: code by email, then a new password). */
export default async function ResetPasswordPage() {
  const useCognito = cognitoConfigured() && process.env.RODEO_LOCAL_LOGIN !== '1';
  return <ResetPasswordForm authConfig={useCognito ? clientAuthConfig() : null} />;
}
