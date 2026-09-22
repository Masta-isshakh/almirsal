'use client';

import { useEffect, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { useUi } from '../webclient/ui';
import type { SessionInfo } from '../webclient/WebClient';

type Prefs = Record<string, unknown>;

const KEY = 'rodeo.discuss.prefs';

/**
 * Discuss › Configuration › Notifications and Voice & Video (C-8.1 config
 * menus): per-user preferences stored on the user record (`rodeo.prefs`
 * config parameter keyed by user) — mute durations, custom notification
 * level, push notifications, sounds, call devices, push-to-talk, blur.
 */
export function DiscussSettingsDialog({ kind, user, onDone }: { kind: "notifications" | "call"; user?: SessionInfo; onDone?: (changed: boolean) => void }) {
  const t = useT();
  const ui = useUi();
  const [prefs, setPrefs] = useState<Prefs>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    rpc<Prefs>('getUserPrefs', null, { key: KEY }, { silent: true }).then((p) => { setPrefs(p ?? {}); setLoaded(true); }).catch(() => setLoaded(true));
  }, [user?.uid]);
  const set = (name: string, value: unknown) => setPrefs((p) => ({ ...p, [name]: value }));
  const save = async () => {
    try { await rpc('setUserPrefs', null, { key: KEY, values: prefs }); ui.notify({ type: 'success', message: { en: 'Preferences saved.', ar: 'تم حفظ التفضيلات.' } }); onDone?.(true); }
    catch (error) { ui.notify({ type: 'danger', message: String((error as Error).message ?? error) }); }
  };
  const Toggle = ({ name, label }: { name: string; label: string }) => (
    <label className="d-flex align-items-center justify-content-between py-2 border-bottom">
      <span>{t(label)}</span>
      <input type="checkbox" className="form-check-input" checked={Boolean(prefs[name])} onChange={(e) => set(name, e.target.checked)} />
    </label>
  );
  if (!loaded) return <div className="p-4 text-center text-muted"><i className="fa fa-circle-o-notch fa-spin" /></div>;
  return (
    <div className="o_discuss_settings">
      {kind === 'notifications' ? (
        <>
          <div className="fw-bold mb-2">{t('Mute all conversations')}</div>
          <select className="form-select mb-3" value={String(prefs.mute ?? '')} onChange={(e) => set('mute', e.target.value)}>
            <option value="">{t('Not muted')}</option>
            <option value="15m">{t('For 15 minutes')}</option><option value="1h">{t('For 1 hour')}</option><option value="3h">{t('For 3 hours')}</option>
            <option value="8h">{t('For 8 hours')}</option><option value="24h">{t('For 24 hours')}</option><option value="forever">{t('Until I turn it back on')}</option>
          </select>
          <div className="fw-bold mb-2">{t('Custom notifications')}</div>
          <select className="form-select mb-3" value={String(prefs.level ?? 'all')} onChange={(e) => set('level', e.target.value)}>
            <option value="all">{t('All Messages')}</option><option value="mentions">{t('Mentions Only')}</option><option value="nothing">{t('Nothing')}</option>
          </select>
          <Toggle name="push" label="Push notifications" />
          <Toggle name="sounds" label="Sounds" />
        </>
      ) : (
        <>
          <div className="fw-bold mb-2">{t('Voice & Video')}</div>
          <Toggle name="pushToTalk" label="Push-to-talk" />
          <label className="d-flex align-items-center justify-content-between py-2 border-bottom"><span>{t('Voice detection threshold')}</span><input type="range" min={0} max={100} value={Number(prefs.threshold ?? 50)} onChange={(e) => set('threshold', Number(e.target.value))} /></label>
          <Toggle name="videoOnly" label="Show video participants only" />
          <Toggle name="blur" label="Blur video background" />
        </>
      )}
      <div className="d-flex gap-2 mt-3">
        <button type="button" className="btn btn-primary" onClick={save}>{t('Save')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => onDone?.(false)}>{t('Discard')}</button>
      </div>
    </div>
  );
}
