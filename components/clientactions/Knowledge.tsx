'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from '../webclient/ui';

/**
 * Knowledge (the article editor).
 *
 * Odoo renders this screen with a custom widget, so the export carries only
 * the article's hidden fields and a generic form shows nothing. This is the
 * screen it stands for: the tree on the side (favourites, workspace, shared,
 * private, trash), the title and the body, and the actions that go with an
 * article — new, new child, favourite, move to trash, restore, duplicate.
 */

interface Article {
  id: number;
  name: string;
  icon: string | false;
  parent_id: [number, string] | false;
  category: 'workspace' | 'private' | 'shared';
  is_user_favorite: boolean;
  to_delete: boolean;
  sequence: number;
  has_article_children?: boolean;
}

const FIELDS = ['name', 'icon', 'parent_id', 'category', 'is_user_favorite', 'to_delete', 'sequence'];
const UNTITLED = { en: 'Untitled', ar: 'بلا عنوان' };

export function Knowledge({ recordId }: { recordId: number | null }) {
  const t = useT();
  const ui = useUi();
  const { navigate } = useNavigation();
  const [articles, setArticles] = useState<Article[]>([]);
  const [current, setCurrent] = useState<number | null>(recordId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [trash, setTrash] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadedFor = useRef<number | null>(null);

  const loadTree = useCallback(async () => {
    // Templates live in Odoo's gallery and article items are embedded in a
    // page; neither belongs in the tree.
    const rows = await rpc<Article[]>('searchRead', 'knowledge.article', {
      domain: [['is_template', '=', false], ['is_article_item', '=', false]],
      fields: FIELDS, order: 'sequence, id', limit: 500,
    }, { context: { active_test: false } }).catch(() => []);
    setArticles(rows);
    return rows;
  }, []);

  useEffect(() => { void loadTree(); }, [loadTree]);
  useEffect(() => { setCurrent(recordId); }, [recordId]);

  // Load the open article's title and body once per article.
  useEffect(() => {
    if (!current) { loadedFor.current = null; setTitle(''); setBody(''); return; }
    if (loadedFor.current === current) return;
    loadedFor.current = current;
    void (async () => {
      const [record] = await rpc<{ name: string; body: string | false }[]>('read', 'knowledge.article', { ids: [current], fields: ['name', 'body'] }).catch(() => []);
      setTitle(record?.name ?? '');
      // The editor is filled by React, not by hand: the tree can still be
      // loading when this runs, and then there is no element to write into.
      setBody(typeof record?.body === 'string' ? record.body : '');
    })();
  }, [current]);

  const save = useCallback(async (values: Record<string, unknown>) => {
    if (!current) return;
    setSaving('saving');
    await rpc('write', 'knowledge.article', { ids: [current], values }).catch((error) => {
      ui.notify({ type: 'warning', message: String((error as Error).message ?? error) });
    });
    setSaving('saved');
    setTimeout(() => setSaving('idle'), 1200);
    await loadTree();
  }, [current, loadTree, ui]);

  // The title and body save shortly after typing stops, as Odoo does.
  useEffect(() => {
    if (!current || loadedFor.current !== current) return undefined;
    const handle = setTimeout(() => { void save({ name: title || t(UNTITLED) }); }, 700);
    return () => clearTimeout(handle);
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (parent?: number) => {
    const values: Record<string, unknown> = { name: t(UNTITLED), body: '' };
    if (parent) { values.parent_id = parent; }
    const id = await rpc<number>('create', 'knowledge.article', { values }).catch((error) => {
      ui.notify({ type: 'warning', message: String((error as Error).message ?? error) });
      return 0;
    });
    if (!id) return;
    await loadTree();
    if (parent) setOpen((current) => new Set(current).add(parent));
    setTrash(false);
    navigate(`/odoo/articles/${id}`);
  };

  const remove = async (id: number) => {
    await rpc('write', 'knowledge.article', { ids: [id], values: { to_delete: true, active: false } }).catch(() => {});
    await loadTree();
    if (current === id) navigate('/odoo/articles');
    ui.notify({ type: 'info', message: { en: 'Article moved to trash.', ar: 'تم نقل المقالة إلى المهملات.' } });
  };
  const restore = async (id: number) => {
    await rpc('write', 'knowledge.article', { ids: [id], values: { to_delete: false, active: true } }).catch(() => {});
    await loadTree();
  };
  const duplicate = async (id: number) => {
    const copy = await rpc<number>('copy', 'knowledge.article', { id }).catch(() => 0);
    if (!copy) return;
    await loadTree();
    navigate(`/odoo/articles/${copy}`);
  };
  const toggleFavorite = async (article: Article) => {
    await rpc('write', 'knowledge.article', { ids: [article.id], values: { is_user_favorite: !article.is_user_favorite } }).catch(() => {});
    await loadTree();
  };

  const live = useMemo(() => articles.filter((a) => !a.to_delete), [articles]);
  const matching = useMemo(() => {
    if (!search.trim()) return null;
    const needle = search.trim().toLowerCase();
    return live.filter((a) => (a.name || '').toLowerCase().includes(needle));
  }, [live, search]);
  const childrenOf = (parent: number | null) => live.filter((a) => (a.parent_id ? a.parent_id[0] : null) === parent);
  const article = articles.find((a) => a.id === current) ?? null;

  const row = (item: Article, depth: number) => {
    const kids = childrenOf(item.id);
    const expanded = open.has(item.id);
    return (
      <div key={item.id}>
        <div className={`o_knowledge_row ${current === item.id ? 'o_active' : ''}`} style={{ paddingInlineStart: 8 + depth * 14 }}>
          <button type="button" className="o_knowledge_caret" onClick={() => setOpen((set) => { const next = new Set(set); if (expanded) next.delete(item.id); else next.add(item.id); return next; })}
            style={{ visibility: kids.length ? 'visible' : 'hidden' }} aria-label={t('Expand')}>
            <i className={`fa fa-caret-${expanded ? 'down' : 'right'}`} />
          </button>
          <button type="button" className="o_knowledge_name" onClick={() => { setTrash(false); navigate(`/odoo/articles/${item.id}`); }}>
            <span className="o_knowledge_icon">{item.icon || '📄'}</span>
            <span className="text-truncate">{item.name || t(UNTITLED)}</span>
          </button>
          <button type="button" className="o_knowledge_add" title={t('New article')} onClick={() => void create(item.id)}><i className="fa fa-plus" /></button>
        </div>
        {expanded && kids.map((kid) => row(kid, depth + 1))}
      </div>
    );
  };

  const section = (label: { en: string; ar: string }, items: Article[], empty: { en: string; ar: string }) => (
    <div className="o_knowledge_section">
      <div className="o_knowledge_section_title">{t(label)}</div>
      {items.length ? items.map((item) => row(item, 0)) : <div className="o_knowledge_empty">{t(empty)}</div>}
    </div>
  );

  const deleted = articles.filter((a) => a.to_delete);
  return (
    <div className="o_knowledge">
      <aside className="o_knowledge_sidebar">
        <div className="o_knowledge_search">
          <i className="fa fa-search" />
          <input className="o_input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('Search articles...')} />
        </div>
        <button type="button" className="btn btn-primary btn-sm w-100 mb-2" onClick={() => void create()}>{t('New article')}</button>
        {matching ? (
          <div className="o_knowledge_section">
            <div className="o_knowledge_section_title">{t('Results')}</div>
            {matching.length ? matching.map((item) => row(item, 0)) : <div className="o_knowledge_empty">{t('No article found.')}</div>}
          </div>
        ) : (
          <>
            {live.some((a) => a.is_user_favorite) && section({ en: 'Favorites', ar: 'المفضلة' }, live.filter((a) => a.is_user_favorite), { en: 'No favorite yet.', ar: 'لا توجد مفضلات بعد.' })}
            {section({ en: 'Workspace', ar: 'مساحة العمل' }, childrenOf(null).filter((a) => a.category === 'workspace'), { en: 'No article yet.', ar: 'لا توجد مقالات بعد.' })}
            {section({ en: 'Shared with me', ar: 'مشارَكة معي' }, childrenOf(null).filter((a) => a.category === 'shared'), { en: 'Nothing shared with you.', ar: 'لا يوجد ما تمت مشاركته معك.' })}
            {section({ en: 'Private', ar: 'خاص' }, childrenOf(null).filter((a) => a.category === 'private'), { en: 'No private article.', ar: 'لا توجد مقالات خاصة.' })}
            <button type="button" className={`o_knowledge_trash_toggle ${trash ? 'o_active' : ''}`} onClick={() => setTrash((value) => !value)}>
              <i className="fa fa-trash-o me-2" />{t('Trash')}{deleted.length ? ` (${deleted.length})` : ''}
            </button>
          </>
        )}
      </aside>

      <section className="o_knowledge_main">
        {trash ? (
          <div className="o_knowledge_trash">
            <h2 className="fs-5 mb-3">{t('Trash')}</h2>
            {deleted.length === 0 && <div className="text-muted">{t('Trash is empty.')}</div>}
            {deleted.map((item) => (
              <div key={item.id} className="o_knowledge_trash_row">
                <span>{item.icon || '📄'} {item.name || t(UNTITLED)}</span>
                <span className="d-flex gap-2">
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => void restore(item.id)}>{t('Restore')}</button>
                  <button type="button" className="btn btn-sm btn-link text-danger" onClick={async () => {
                    if (!(await ui.confirm({ message: { en: 'Delete this article permanently?', ar: 'حذف هذه المقالة نهائياً؟' } }))) return;
                    await rpc('unlink', 'knowledge.article', { ids: [item.id] }).catch(() => {});
                    await loadTree();
                  }}>{t('Delete permanently?')}</button>
                </span>
              </div>
            ))}
          </div>
        ) : !article ? (
          <div className="o_knowledge_placeholder">
            <i className="fa fa-book fa-3x mb-3 opacity-50" />
            <p className="mb-3">{t('Pick an article on the left, or write a new one.')}</p>
            <button type="button" className="btn btn-primary" onClick={() => void create()}>{t('New article')}</button>
          </div>
        ) : (
          <>
            <div className="o_knowledge_toolbar">
              <span className="o_knowledge_breadcrumb">{article.icon || '📄'} {article.name || t(UNTITLED)}</span>
              <span className="o_knowledge_status">
                {saving === 'saving' ? <i className="fa fa-spinner fa-spin" /> : saving === 'saved' ? <i className="fa fa-cloud text-muted" title={t('Saved')} /> : null}
              </span>
              <span className="d-flex gap-1 ms-auto">
                <button type="button" className="btn btn-sm btn-link" title={t('Add to favorites')} onClick={() => void toggleFavorite(article)}>
                  <i className={`fa fa-star${article.is_user_favorite ? '' : '-o'}`} />
                </button>
                <button type="button" className="btn btn-sm btn-link" title={t('New article')} onClick={() => void create(article.id)}><i className="fa fa-plus" /></button>
                <button type="button" className="btn btn-sm btn-link" title={t('Duplicate')} onClick={() => void duplicate(article.id)}><i className="fa fa-clone" /></button>
                <button type="button" className="btn btn-sm btn-link text-danger" title={t('Move to trash')} onClick={() => void remove(article.id)}><i className="fa fa-trash-o" /></button>
              </span>
            </div>
            <div className="o_knowledge_page">
              <input className="o_knowledge_title" value={title} placeholder={t(UNTITLED)} onChange={(event) => setTitle(event.target.value)} />
              <div key={`${current}:${loadedFor.current === current ? 'ready' : 'loading'}`} ref={bodyRef} className="o_knowledge_body"
                contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: body }}
                onBlur={(event) => { const html = event.currentTarget.innerHTML; if (html === body) return; setBody(html); void save({ body: html }); }} />
              {!body && <div className="o_knowledge_hint">{t('Write your article here…')}</div>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
