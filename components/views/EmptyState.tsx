'use client';

import type { I18n } from '@engine/i18n/types';
import { useT } from '@/lib/client/i18n';

/** B-8 / B-4: the centered help block shown when a view has no records. */
export function EmptyState({ help }: { help?: I18n }) {
  const t = useT();
  const text = help ? t(help) : '';
  const [title, ...rest] = text.split(/(?<=[.!?])\s+/);
  return (
    <div className="o_view_nocontent">
      <div className="o_nocontent_help">
        <div className="o_nocontent_illustration"><i className="fa fa-file-text-o" aria-hidden="true" /></div>
        {title && <h2>{title}</h2>}
        {rest.length > 0 && <p>{rest.join(' ')}</p>}
        {!text && <p className="text-muted">{t('No records found')}</p>}
      </div>
    </div>
  );
}
