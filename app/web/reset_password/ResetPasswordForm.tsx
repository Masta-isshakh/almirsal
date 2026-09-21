'use client';

import { useState, type FormEvent } from 'react';
import { useT } from '@/lib/client/i18n';

/**
 * Reset Password (B-10): step 1 asks for the email and Cognito mails a code
 * ("Almirsal — your password reset code"); step 2 takes the code and the new
 * password. Without Cognito (local login) the administrator sets it.
 */
export function ResetPasswordForm({ authConfig }: { authConfig: Record<string, unknown> | null }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function amplify() {
    const { Amplify } = await import('aws-amplify');
    Amplify.configure(authConfig as never, { ssr: true });
    return import('aws-amplify/auth');
  }

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const { resetPassword } = await amplify();
      const result = await resetPassword({ username: email.trim() });
      if (result.nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE') setStep('code'); else setStep('done');
    } catch (caught) {
      const name = (caught as { name?: string })?.name ?? '';
      setError(name === 'UserNotFoundException' ? t('No account uses this email address.') : name === 'LimitExceededException' ? t('Too many attempts, try again later.') : `${(caught as Error).message}`);
    } finally { setBusy(false); }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      if (password.length < 8) throw new Error(t('The new password must be at least 8 characters long.'));
      const { confirmResetPassword } = await amplify();
      await confirmResetPassword({ username: email.trim(), confirmationCode: code.trim(), newPassword: password });
      setStep('done');
    } catch (caught) {
      const name = (caught as { name?: string })?.name ?? '';
      setError(name === 'CodeMismatchException' ? t('The code is wrong.') : name === 'ExpiredCodeException' ? t('The code has expired, request a new one.') : (caught as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="o_login_page">
      <form className="o_login_card" onSubmit={step === 'email' ? requestCode : confirm} noValidate>
        <div className="o_login_logo"><span className="o_login_brand">Almirsal</span></div>
        <hr />
        <h5 className="mb-3">{t('Reset Password')}</h5>
        {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
        {!authConfig && (
          <div className="alert alert-info py-2">{t('Passwords are managed by your administrator: ask them to set a new one for you (Settings › Users).')}</div>
        )}
        {authConfig && step === 'email' && (
          <>
            <div className="mb-3">
              <label htmlFor="email">{t('Email')}</label>
              <input id="email" type="email" className="form-control" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
              <div className="form-text">{t('We will email you a code to choose a new password.')}</div>
            </div>
            <button type="submit" className="btn btn-primary w-100" disabled={busy}>{busy ? t('Sending...') : t('Send the code')}</button>
          </>
        )}
        {authConfig && step === 'code' && (
          <>
            <div className="alert alert-success py-2">{t('A code was sent to')} <strong>{email}</strong>.</div>
            <div className="mb-3">
              <label htmlFor="code">{t('Code')}</label>
              <input id="code" className="form-control" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
            </div>
            <div className="mb-3">
              <label htmlFor="password">{t('New password')}</label>
              <input id="password" type="password" className="form-control" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
            </div>
            <button type="submit" className="btn btn-primary w-100" disabled={busy}>{busy ? t('Saving...') : t('Change Password')}</button>
            <button type="button" className="btn btn-link w-100 mt-1" onClick={() => setStep('email')}>{t('Request another code')}</button>
          </>
        )}
        {step === 'done' && (
          <div className="alert alert-success py-2">{t('Your password has been changed. You can log in now.')}</div>
        )}
        <div className="o_login_footer">
          <hr className="mb-2" />
          <a href="/web/login">{t('Back to login')}</a>
        </div>
      </form>
    </div>
  );
}
