'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { I18n } from '@engine/i18n/types';
import { useT } from '@/lib/client/i18n';

/**
 * Dialog stack and toast notifications (A-4 §1, §16, B-4). Dialogs are
 * modal, stack with an offset, close on Escape; toasts show top-end for
 * 4 s unless sticky.
 */

export interface DialogSpec {
  id: number;
  title: I18n | string;
  body: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** `undefined` = default Ok footer; `null` = the body renders its own. */
  footer?: ReactNode | null;
  onClose?: () => void;
}

export interface NotificationSpec {
  id: number;
  title?: I18n | string;
  message: I18n | string;
  type: 'success' | 'warning' | 'danger' | 'info';
  sticky?: boolean;
  /** Optional button (e.g. "Undo"); the toast closes when it is clicked. */
  action?: { label: I18n | string; onClick: () => void };
}

interface UiApi {
  dialogs: DialogSpec[];
  notifications: NotificationSpec[];
  openDialog: (spec: Omit<DialogSpec, 'id'>) => number;
  closeDialog: (id: number) => void;
  showError: (payload: { title: I18n | string; message: I18n | string; debug?: string }) => void;
  confirm: (options: { title?: I18n | string; message: I18n | string; confirmLabel?: I18n | string }) => Promise<boolean>;
  notify: (spec: Omit<NotificationSpec, 'id'>) => number;
  dismiss: (id: number) => void;
}

const UiContext = createContext<UiApi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [dialogs, setDialogs] = useState<DialogSpec[]>([]);
  const [notifications, setNotifications] = useState<NotificationSpec[]>([]);
  const counter = useRef(0);

  const closeDialog = useCallback((id: number) => {
    setDialogs((list) => {
      const target = list.find((dialog) => dialog.id === id);
      target?.onClose?.();
      return list.filter((dialog) => dialog.id !== id);
    });
  }, []);

  const openDialog = useCallback((spec: Omit<DialogSpec, 'id'>) => {
    const id = ++counter.current;
    setDialogs((list) => [...list, { ...spec, id }]);
    return id;
  }, []);

  const notify = useCallback((spec: Omit<NotificationSpec, 'id'>) => {
    const id = ++counter.current;
    setNotifications((list) => [...list, { ...spec, id }]);
    if (!spec.sticky) setTimeout(() => setNotifications((list) => list.filter((item) => item.id !== id)), spec.action ? 8000 : 4000);
    return id;
  }, []);
  const dismiss = useCallback((id: number) => setNotifications((list) => list.filter((item) => item.id !== id)), []);

  const api = useMemo<UiApi>(() => ({
    dialogs,
    notifications,
    openDialog,
    closeDialog,
    showError: (payload) => {
      openDialog({
        title: payload.title,
        size: 'sm',
        body: <ErrorBody message={payload.message} debug={payload.debug} />,
      });
    },
    confirm: (options) => new Promise((resolve) => {
      const id = ++counter.current;
      const finish = (value: boolean) => {
        setDialogs((list) => list.filter((dialog) => dialog.id !== id));
        resolve(value);
      };
      setDialogs((list) => [...list, {
        id,
        title: options.title ?? { en: 'Confirmation', ar: 'تأكيد' },
        size: 'sm',
        body: <TextBody value={options.message} />,
        footer: <ConfirmFooter onOk={() => finish(true)} onCancel={() => finish(false)} okLabel={options.confirmLabel} />,
        onClose: () => resolve(false),
      }]);
    }),
    notify,
    dismiss,
  }), [dialogs, notifications, openDialog, closeDialog, notify, dismiss]);

  return <UiContext.Provider value={api}>{children}</UiContext.Provider>;
}

export function useUi(): UiApi {
  const api = useContext(UiContext);
  if (!api) throw new Error('useUi must be used inside UiProvider');
  return api;
}

function TextBody({ value }: { value: I18n | string }) {
  const t = useT();
  return <>{t(value)}</>;
}

function ErrorBody({ message, debug }: { message: I18n | string; debug?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div>{t(message)}</div>
      {debug && (
        <div className="mt-3">
          <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setOpen((v) => !v)}>{t('See details')}</button>
          {open && <pre className="small text-muted mt-2" style={{ whiteSpace: 'pre-wrap' }}>{debug}</pre>}
        </div>
      )}
    </div>
  );
}

function ConfirmFooter({ onOk, onCancel, okLabel }: { onOk: () => void; onCancel: () => void; okLabel?: I18n | string }) {
  const t = useT();
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={onOk} autoFocus>{t(okLabel ?? 'Ok')}</button>
      <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('Cancel')}</button>
    </>
  );
}

export function DialogHost() {
  const { dialogs, closeDialog } = useUi();
  const t = useT();
  if (dialogs.length === 0) return null;
  return (
    <>
      {dialogs.map((dialog, index) => (
        <div key={dialog.id} className="o_dialog_backdrop" style={{ zIndex: 1100 + index }}
          onKeyDown={(event) => { if (event.key === 'Escape') closeDialog(dialog.id); }}>
          <div className={`o_dialog ${dialog.size === 'sm' ? 'o_dialog_sm' : dialog.size === 'lg' ? 'o_dialog_lg' : ''}`}
            role="dialog" aria-modal="true" style={{ marginTop: index * 24 }}>
            <div className="o_dialog_header">
              <h4>{t(dialog.title)}</h4>
              <button type="button" className="btn-close" aria-label="Close" onClick={() => closeDialog(dialog.id)} />
            </div>
            <div className="o_dialog_body">{dialog.body}</div>
            {dialog.footer === null ? null : dialog.footer !== undefined ? (
              <div className="o_dialog_footer">{dialog.footer}</div>
            ) : (
              <div className="o_dialog_footer">
                <button type="button" className="btn btn-primary" onClick={() => closeDialog(dialog.id)} autoFocus>{t('Ok')}</button>
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

export function NotificationHost() {
  const { notifications, dismiss } = useUi();
  const t = useT();
  if (notifications.length === 0) return null;
  return (
    <div className="o_notification_manager">
      {notifications.map((notification) => (
        <div key={notification.id} className={`o_notification o_notification_${notification.type} d-flex align-items-start gap-2`}>
          <div className="flex-grow-1">
            {notification.title && <div className="o_notification_title">{t(notification.title)}</div>}
            <div>{t(notification.message)}</div>
          </div>
          {notification.action && (
            <button type="button" className="btn btn-link btn-sm p-0 fw-bold text-nowrap" onClick={() => { notification.action?.onClick(); dismiss(notification.id); }}>{t(notification.action.label)}</button>
          )}
          <button type="button" className="btn-close btn-sm" aria-label="Close" onClick={() => dismiss(notification.id)} />
        </div>
      ))}
    </div>
  );
}
