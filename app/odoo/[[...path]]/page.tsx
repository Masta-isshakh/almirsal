import { redirect } from 'next/navigation';
import { getRegistry } from '@/lib/server/registry';
import { getRequestLang, getSessionUser } from '@/lib/server/session';
import { resolvePath, menuHref } from '@/lib/server/actions';
import { appSlug } from '@/lib/apps';
import { WebClient, type AppEntry } from '@/components/webclient/WebClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** `/odoo/...` — the web client. Everything under it needs a session. */
export default async function OdooPage({ params, searchParams }: PageProps) {
  const user = await getSessionUser();
  const { path = [] } = await params;
  const query = await searchParams;
  if (!user) {
    const target = `/odoo/${path.join('/')}`;
    redirect(`/web/login?redirect=${encodeURIComponent(target)}`);
  }
  const lang = await getRequestLang(user);
  const registry = getRegistry();
  const resolution = resolvePath(path, query);

  // Hrefs for every menu item, so the navbar never needs the action registry.
  const menuHrefs: Record<number, string> = {};
  for (const menu of Object.values(registry.menuIndex)) menuHrefs[menu.id] = menuHref(menu);

  const apps: AppEntry[] = registry.menus.map((menu) => ({
    id: menu.id,
    xmlId: menu.xmlId,
    name: menu.name,
    slug: appSlug(menu.xmlId, menu.name.en),
    href: menuHref(menu),
    children: menu.children,
  }));

  return (
    <WebClient
      user={{ uid: user.uid, name: user.name, login: user.login, lang, companyIds: user.companyIds }}
      apps={apps}
      menuHrefs={menuHrefs}
      resolution={resolution}
      href={`/odoo/${path.map(encodeURIComponent).join('/')}${Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString()}` : ''}`}
    />
  );
}
