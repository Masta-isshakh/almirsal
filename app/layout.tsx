import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'font-awesome/css/font-awesome.min.css';
import '@/styles/tokens.css';
import '@/styles/webclient.css';
import { I18nProvider } from '@/lib/client/i18n';
import { getCatalog } from '@/lib/server/catalog';
import { getRequestLang, getSessionUser } from '@/lib/server/session';

export const metadata: Metadata = {
  title: 'Rodeo ERP',
  description: 'Rodeo ERP',
};

export const dynamic = 'force-dynamic';

/**
 * `<html dir="rtl" lang="ar">` when the language is Arabic (B-9). The
 * Bootstrap RTL build is swapped in with a second stylesheet so utilities
 * like `ms-auto` mirror; component CSS uses logical properties.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  const lang = await getRequestLang(user);
  const dir = lang === 'ar_001' ? 'rtl' : 'ltr';
  return (
    <html lang={lang === 'ar_001' ? 'ar' : 'en'} dir={dir} data-lang={lang}>
      <head>
        {dir === 'rtl' && <link rel="stylesheet" href="/vendor/bootstrap.rtl.min.css" />}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700&family=Noto+Sans+Arabic:wght@400;500;700&display=swap" />
      </head>
      <body className={`o_web_client_body${dir === 'rtl' ? ' o_rtl' : ''}`}>
        <I18nProvider lang={lang} catalog={getCatalog(lang)}>{children}</I18nProvider>
      </body>
    </html>
  );
}
