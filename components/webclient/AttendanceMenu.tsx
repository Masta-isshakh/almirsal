'use client';

import { useEffect, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { Dropdown } from './Navbar';

interface Status { enabled: boolean; employeeId: number | null; name: string; state: 'checked_in' | 'checked_out'; since: string | null; hoursToday: number; hoursThisWeek: number }

const hours = (value: number) => `${Math.floor(value)}:${String(Math.round((value % 1) * 60)).padStart(2, '0')}`;

/**
 * Attendances systray item (D-8): the check-in / check-out toggle of the
 * user's employee with today's and this week's worked hours. Hidden when
 * the user has no employee or Settings › Attendances turned the systray off.
 */
export function AttendanceMenu() {
  const t = useT();
  const lang = useLang();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { rpc<Status>('attendanceStatus', null, {}, { silent: true }).then(setStatus).catch(() => setStatus(null)); }, []);
  if (!status?.enabled) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      const geo = await new Promise<{ latitude?: number; longitude?: number }>((resolve) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve({});
        navigator.geolocation.getCurrentPosition((p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }), () => resolve({}), { timeout: 1500 });
      });
      setStatus(await rpc<Status>('attendanceToggle', null, { geo }));
    } catch { /* the RPC layer already showed the error */ }
    setBusy(false);
  };
  const checkedIn = status.state === 'checked_in';
  const sinceLabel = status.since ? new Date(status.since.replace(' ', 'T') + 'Z').toLocaleTimeString(lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <Dropdown end toggle={(open) => (
      <button type="button" className={`o_systray_item ${open ? 'active' : ''}`} title={t(checkedIn ? 'Check out' : 'Check in')}>
        <i className={`fa fa-lg ${checkedIn ? 'fa-sign-out text-danger' : 'fa-sign-in text-success'}`} />
      </button>
    )}>
      <div className="o_systray_panel o_attendance_panel" style={{ width: 300 }}>
        <div className="o_dropdown_header d-flex justify-content-between align-items-center">
          <span>{status.name}</span>
          <span className={`badge ${checkedIn ? 'text-bg-success' : 'text-bg-secondary'}`}>{t(checkedIn ? 'Checked in' : 'Checked out')}</span>
        </div>
        <div className="px-3 py-2 small">
          {checkedIn ? <div>{t('Checked in since')} <b>{sinceLabel}</b></div> : <div className="text-muted">{t('Not checked in yet')}</div>}
          <div className="d-flex justify-content-between mt-2"><span>{t('Today')}</span><b>{hours(status.hoursToday)}</b></div>
          <div className="d-flex justify-content-between"><span>{t('This week')}</span><b>{hours(status.hoursThisWeek)}</b></div>
        </div>
        <div className="px-3 pb-3">
          <button type="button" className={`btn w-100 ${checkedIn ? 'btn-danger' : 'btn-success'}`} disabled={busy} onClick={() => void toggle()}>
            <i className={`fa ${checkedIn ? 'fa-sign-out' : 'fa-sign-in'} me-1`} />{t(checkedIn ? 'Check out' : 'Check in')}
          </button>
        </div>
      </div>
    </Dropdown>
  );
}
