'use client';

import { useState, type FormEvent } from 'react';
import { useT } from '@/lib/client/i18n';

/**
 * B-10: centered white card on the lavender background — logo placeholder,
 * Email, Password with "Reset Password" link and eye toggle, full-width
 * "Log in", "- or -" and the passkey button, "Powered by Rodeo Drive".
 */
export function LoginForm({ authConfig, redirectTo }: { authConfig: Record<string, unknown> | null; redirectTo: string }) {
  const cognito = authConfig !== null;
  const t = useT();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Cognito asked for a new password (user created with a temporary one). */
  const [newPassword, setNewPassword] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (cognito) {
        const { Amplify } = await import('aws-amplify');
        const { signIn, signOut, confirmSignIn } = await import('aws-amplify/auth');
        // ssr: true keeps the tokens in cookies, where the server reads them.
        Amplify.configure(authConfig as never, { ssr: true });
        let result;
        if (newPassword !== null) {
          result = await confirmSignIn({ challengeResponse: newPassword });
        } else {
          await signOut().catch(() => undefined);
          result = await signIn({ username: login, password });
          if (!result.isSignedIn && result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
            setNewPassword('');
            setBusy(false);
            return;
          }
        }
        if (!result.isSignedIn) throw new Error(`Additional sign-in step required: ${result.nextStep.signInStep}`);
      } else {
        const response = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }),
        });
        if (!response.ok) throw new Error('wrong_login');
      }
      window.location.href = redirectTo;
    } catch (caught) {
      const name = (caught as { name?: string })?.name ?? '';
      const message = (caught as { message?: string })?.message ?? '';
      if (name === 'NotAuthorizedException' || name === 'UserNotFoundException' || message === 'wrong_login') setError(t('Wrong login/password'));
      else setError(`${t('Wrong login/password')} (${name || 'error'}: ${message})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="o_login_page">
      <form className="o_login_card" onSubmit={submit} noValidate>
        <div className="o_login_logo" aria-label="Your logo">📷 {t('Your logo')}</div>
        <hr />
        {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
        <div className="mb-3">
          <label htmlFor="login">{t('Email')}</label>
          <input id="login" type="email" className="form-control" placeholder={t('Enter your email')} value={login}
            onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus required />
        </div>
        <div className="mb-3">
          <div className="d-flex justify-content-between align-items-center">
            <label htmlFor="password" className="mb-1">{t('Password')}</label>
            <a href="/web/reset_password" className="small">{t('Reset Password')}</a>
          </div>
          <div className="input-group">
            <input id="password" type={show ? 'text' : 'password'} className="form-control" placeholder={t('Enter your password')}
              value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            <button type="button" className="btn btn-secondary" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
              <i className={`fa ${show ? 'fa-eye-slash' : 'fa-eye'}`} />
            </button>
          </div>
        </div>
        {newPassword !== null && (
          <div className="mb-3">
            <label htmlFor="new_password">{t('New Password')}</label>
            <input id="new_password" type="password" className="form-control" placeholder={t('Choose a new password')} value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" autoFocus required minLength={8} />
            <div className="form-text">{t('Your account was created with a temporary password. Choose a permanent one to continue.')}</div>
          </div>
        )}
        <button type="submit" className="btn btn-primary w-100" disabled={busy}>{newPassword !== null ? t('Set password and log in') : t('Log in')}</button>
        <div className="text-center text-muted my-2 small">- {t('or')} -</div>
        <button type="button" className="btn btn-outline-primary w-100" disabled title={t('Passkeys are configured from My Preferences')}>
          <i className="fa fa-qrcode me-2" />{t('Use a Passkey')}
        </button>
        <div className="o_login_footer">
          <hr className="mb-2" />
          {t('Powered by')} <a href="https://rodeo.drive" target="_blank" rel="noreferrer">Rodeo Drive</a>
        </div>
      </form>
    </div>
  );
}
