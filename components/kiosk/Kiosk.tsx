'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/client/i18n';

interface Settings { mode: 'barcode' | 'manual' | 'barcode_manual'; usePin: boolean; delay: number; company: string }
interface Employee { id: number; name: string; department: string; state: 'checked_in' | 'checked_out' }
interface Result { employeeId: number; name: string; state: 'checked_in' | 'checked_out'; hoursToday: number; since: string | null }

async function call<T>(key: string, op: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/kiosk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, op, ...params }) });
  const body = (await response.json()) as { result?: T; error?: { message?: { en: string; ar: string } | string } };
  if (!response.ok || body.error) { const m = body.error?.message; throw new Error(typeof m === 'string' ? m : m?.en ?? 'Request failed'); }
  return body.result as T;
}

/**
 * Attendance kiosk (D-8): a public full-screen page for a tablet at the
 * entrance. Badge scanners type the code and press Enter; "Identify
 * Manually" lists the employees, optionally protected by a PIN. The result
 * screen returns to the start after the configured delay.
 */
export function Kiosk({ kioskKey, settings }: { kioskKey: string; settings: Settings }) {
  const t = useT();
  const [screen, setScreen] = useState<'home' | 'employees' | 'pin' | 'result'>('home');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Employee | null>(null);
  const [pin, setPin] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(new Date());
  const scan = useRef('');

  useEffect(() => { const id = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(id); }, []);

  const finish = useCallback((r: Result) => { setResult(r); setError(''); setScreen('result'); }, []);
  const fail = (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); };

  // Keyboard-wedge barcode scanners: characters then Enter.
  useEffect(() => {
    if (settings.mode === 'manual') return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === 'INPUT') return;
      if (event.key === 'Enter') { const code = scan.current; scan.current = ''; if (code) call<Result>(kioskKey, 'check', { barcode: code }).then(finish).catch(fail); }
      else if (event.key.length === 1) scan.current += event.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kioskKey, settings.mode, finish]);

  useEffect(() => {
    if (screen !== 'result') return;
    const id = setTimeout(() => { setScreen('home'); setSelected(null); setPin(''); setResult(null); }, settings.delay * 1000);
    return () => clearTimeout(id);
  }, [screen, settings.delay]);

  const openEmployees = async () => { setError(''); setScreen('employees'); setEmployees(await call<Employee[]>(kioskKey, 'employees').catch(() => [])); };
  const pick = (employee: Employee) => { setSelected(employee); if (settings.usePin) { setPin(''); setScreen('pin'); } else call<Result>(kioskKey, 'check', { employeeId: employee.id }).then(finish).catch(fail); };
  const submitPin = () => { if (selected) call<Result>(kioskKey, 'check', { employeeId: selected.id, pin }).then(finish).catch(fail); };
  const visible = employees.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()));
  const hours = (v: number) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;

  return (
    <div className="o_kiosk">
      <header className="o_kiosk_header">
        <div className="o_kiosk_company">{settings.company}</div>
        <div className="o_kiosk_clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<small className="ms-2 text-muted">{clock.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</small></div>
      </header>
      {error && <div className="alert alert-danger mx-auto" style={{ maxWidth: 480 }}>{error}</div>}
      {screen === 'home' && (
        <main className="o_kiosk_main">
          <i className="fa fa-clock-o o_kiosk_icon" aria-hidden="true" />
          <h1>{t('Welcome')}</h1>
          {settings.mode !== 'manual' && <p className="text-muted fs-5"><i className="fa fa-barcode me-2" />{t('Scan your badge')}</p>}
          {settings.mode !== 'barcode' && <button type="button" className="btn btn-primary btn-lg px-5" onClick={() => void openEmployees()}><i className="fa fa-user me-2" />{t('Identify Manually')}</button>}
        </main>
      )}
      {screen === 'employees' && (
        <main className="o_kiosk_main o_kiosk_list">
          <div className="d-flex align-items-center gap-2 mb-3 w-100">
            <button type="button" className="btn btn-secondary" onClick={() => setScreen('home')}><i className="fa fa-arrow-left" /></button>
            <input autoFocus className="form-control form-control-lg" placeholder={t('Search employees...')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="o_kiosk_employees">
            {visible.map((e) => (
              <button key={e.id} type="button" className="o_kiosk_employee" onClick={() => pick(e)}>
                <span className="o_avatar o_kiosk_avatar">{e.name.slice(0, 1).toUpperCase()}</span>
                <span className="text-start"><span className="d-block fw-bold">{e.name}</span><small className="text-muted">{e.department}</small></span>
                <span className={`ms-auto badge ${e.state === 'checked_in' ? 'text-bg-success' : 'text-bg-secondary'}`}>{t(e.state === 'checked_in' ? 'Checked in' : 'Checked out')}</span>
              </button>
            ))}
            {visible.length === 0 && <div className="text-muted p-4">{t('No employee found.')}</div>}
          </div>
        </main>
      )}
      {screen === 'pin' && selected && (
        <main className="o_kiosk_main">
          <h2>{selected.name}</h2>
          <p className="text-muted">{t('Please enter your PIN to check in or out')}</p>
          <div className="o_kiosk_pin_display">{'•'.repeat(pin.length) || ' '}</div>
          <div className="o_kiosk_pinpad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'].map((k) => (
              <button key={k} type="button" className={`btn btn-lg ${k === 'OK' ? 'btn-primary' : k === 'C' ? 'btn-secondary' : 'btn-light'}`} onClick={() => (k === 'OK' ? submitPin() : k === 'C' ? setPin('') : setPin((p) => (p + k).slice(0, 8)))}>{k}</button>
            ))}
          </div>
          <button type="button" className="btn btn-link mt-3" onClick={() => setScreen('employees')}>{t('Back')}</button>
        </main>
      )}
      {screen === 'result' && result && (
        <main className="o_kiosk_main">
          <i className={`fa o_kiosk_icon ${result.state === 'checked_in' ? 'fa-sign-in text-success' : 'fa-sign-out text-danger'}`} aria-hidden="true" />
          <h1>{result.state === 'checked_in' ? t('Welcome') : t('Goodbye')}, {result.name}</h1>
          <p className="fs-5 text-muted">{result.state === 'checked_in' ? t('Checked in') : t('Checked out')} · {t('Today')}: <b>{hours(result.hoursToday)}</b></p>
          <button type="button" className="btn btn-secondary" onClick={() => setScreen('home')}>{t('OK')}</button>
        </main>
      )}
    </div>
  );
}
