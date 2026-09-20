'use client';

import { useState } from 'react';
import { useT } from '@/lib/client/i18n';
import { rpc } from '@/lib/client/rpc';
import { useUi } from './ui';

/**
 * My Preferences › Change password. With Cognito the change happens in the
 * user pool from the browser (the current password is required); with the
 * local login it hashes into `res.users.password` through the ORM.
 */
export function ChangePassword({ uid, authConfig, onDone }: { uid: number; authConfig: Record<string, unknown> | null; onDone: () => void }) {
  const t = useT();
  const ui = useUi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (next.length < 8) { setError(t('The new password must be at least 8 characters long.')); return; }
    if (next !== confirm) { setError(t('The passwords do not match.')); return; }
    setBusy(true);
    try {
      if (authConfig) {
        const { Amplify } = await import('aws-amplify');
        const { updatePassword } = await import('aws-amplify/auth');
        Amplify.configure(authConfig as never, { ssr: true });
        await updatePassword({ oldPassword: current, newPassword: next });
      } else {
        await rpc('write', 'res.users', { ids: [uid], values: { new_password: next } });
      }
      ui.notify({ type: 'success', message: { en: 'Password changed.', ar: 'تم تغيير كلمة المرور.' } });
      onDone();
    } catch (caught) {
      const name = (caught as { name?: string })?.name ?? '';
      setError(name === 'NotAuthorizedException' ? t('The current password is wrong.') : `${t('Could not change the password')}: ${(caught as Error).message}`);
    } finally { setBusy(false); }
  };

  return (
    <div>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {authConfig && <div className="mb-3"><label className="o_form_label">{t('Current password')}</label><input type="password" className="form-control" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" /></div>}
      <div className="mb-3"><label className="o_form_label">{t('New password')}</label><input type="password" className="form-control" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" /></div>
      <div className="mb-3"><label className="o_form_label">{t('Confirm new password')}</label><input type="password" className="form-control" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} /></div>
      <div className="o_dialog_footer px-0 pb-0">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? t('Saving...') : t('Change Password')}</button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>{t('Discard')}</button>
      </div>
    </div>
  );
}
