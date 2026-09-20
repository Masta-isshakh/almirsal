import { redirect } from 'next/navigation';
import { clientAuthConfig, cognitoConfigured, getSessionUser } from '@/lib/server/session';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

/** `/web/login` — the B-10 login page. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string; error?: string; logout?: string }> }) {
  const params = await searchParams;
  // Right after "Log out" the form is shown even if a stale token cookie still resolves a user.
  const user = params.logout ? null : await getSessionUser();
  if (user) redirect(params.redirect || '/odoo');
  const useCognito = cognitoConfigured() && process.env.RODEO_LOCAL_LOGIN !== '1';
  return <LoginForm authConfig={useCognito ? clientAuthConfig() : null} redirectTo={params.redirect || '/odoo'} />;
}
