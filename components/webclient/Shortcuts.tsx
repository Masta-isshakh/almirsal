'use client';

import { useT } from '@/lib/client/i18n';

const SHORTCUTS: { keys: string; label: { en: string; ar: string } }[] = [
  { keys: 'Ctrl + K', label: { en: 'Command palette: menus, records, commands', ar: 'لوحة الأوامر: القوائم والسجلات والأوامر' } },
  { keys: 'Alt + H', label: { en: 'Home menu', ar: 'القائمة الرئيسية' } },
  { keys: 'Alt + N', label: { en: 'New record', ar: 'سجل جديد' } },
  { keys: 'Alt + S', label: { en: 'Save the form', ar: 'حفظ النموذج' } },
  { keys: 'Alt + J', label: { en: 'Discard changes', ar: 'تجاهل التغييرات' } },
  { keys: 'Alt + ← / →', label: { en: 'Previous / next record', ar: 'السجل السابق / التالي' } },
  { keys: 'Esc', label: { en: 'Close the dialog / go back', ar: 'إغلاق الحوار / الرجوع' } },
  { keys: '?', label: { en: 'This help', ar: 'هذه المساعدة' } },
  { keys: '← / → / t', label: { en: 'Calendar: previous, next, today', ar: 'التقويم: السابق، التالي، اليوم' } },
  { keys: '/  @  >', label: { en: 'In the palette: menus only / records only / commands only', ar: 'في اللوحة: القوائم فقط / السجلات فقط / الأوامر فقط' } },
];

/** The keyboard shortcuts sheet (user menu › Shortcuts, or `?`). */
export function ShortcutsHelp() {
  const t = useT();
  return (
    <table className="table table-sm mb-0">
      <tbody>
        {SHORTCUTS.map((item) => (
          <tr key={item.keys}>
            <td style={{ width: 150 }}>{item.keys.split(' + ').map((key, index) => <span key={index}>{index > 0 && ' + '}<kbd className="o_kbd">{key}</kbd></span>)}</td>
            <td>{t(item.label)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
