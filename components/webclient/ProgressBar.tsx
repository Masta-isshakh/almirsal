'use client';

import { useEffect, useState } from 'react';
import { onRpcPending } from '@/lib/client/rpc';

/**
 * The thin bar under the navbar that shows while a navigation resolves or
 * any RPC is in flight — perceived speed: the user always sees the app
 * react to a click before the data arrives.
 */
export function ProgressBar({ active }: { active: boolean }) {
  const [pending, setPending] = useState(0);
  useEffect(() => onRpcPending(setPending), []);
  const on = active || pending > 0;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (on) { setVisible(true); return; }
    const handle = setTimeout(() => setVisible(false), 250);
    return () => clearTimeout(handle);
  }, [on]);
  if (!visible) return null;
  return <div className={`o_progress_bar ${on ? 'o_progress_bar_running' : 'o_progress_bar_done'}`} role="progressbar" aria-hidden="true" />;
}
