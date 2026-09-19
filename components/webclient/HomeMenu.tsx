'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/client/i18n';
import type { AppEntry } from './WebClient';

/**
 * C-2: the app grid on the lavender background, 6 tiles per row in root-menu
 * order, arrow keys move focus, Enter opens. Icons are the redrawn SVGs.
 */
export function HomeMenu({ apps }: { apps: AppEntry[] }) {
  const t = useT();
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);

  useEffect(() => { refs.current[focus]?.focus(); }, [focus]);

  function onKeyDown(event: React.KeyboardEvent) {
    const columns = window.innerWidth < 768 ? 3 : 6;
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    if (event.key in moves) {
      event.preventDefault();
      setFocus((index) => Math.max(0, Math.min(apps.length - 1, index + moves[event.key])));
    }
  }

  return (
    <div className="o_home_menu" onKeyDown={onKeyDown}>
      <div className="o_home_menu_grid" role="list">
        {apps.map((app, index) => (
          <Link key={app.id} href={app.href} className="o_app" role="listitem" tabIndex={index === focus ? 0 : -1}
            ref={(element) => { refs.current[index] = element; }} onFocus={() => setFocus(index)}>
            <img className="o_app_icon" src={`/icons/apps/${app.slug}.svg`} alt="" width={70} height={70} />
            <span className="o_app_caption">{t(app.name)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
