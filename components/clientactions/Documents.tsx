'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from '../webclient/ui';
import type { SessionInfo } from '../webclient/WebClient';

type Rec = Record<string, unknown>;
interface Folder { id: number; name: string; parent: number | null; children: Folder[] }
type Section = 'company' | 'mine' | 'recent' | 'trash';

const nameOf = (v: unknown) => (Array.isArray(v) ? String(v[1]) : '');
const idOf = (v: unknown) => (Array.isArray(v) ? Number(v[0]) : typeof v === 'number' ? v : null);
const sizeOf = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);
const iconOf = (mimetype: string, type: string) => type === 'url' ? 'fa-link' : type === 'folder' ? 'fa-folder' : /pdf/.test(mimetype) ? 'fa-file-pdf-o' : /image/.test(mimetype) ? 'fa-file-image-o' : /sheet|excel|csv/.test(mimetype) ? 'fa-file-excel-o' : /word|document/.test(mimetype) ? 'fa-file-word-o' : /zip|compressed/.test(mimetype) ? 'fa-file-archive-o' : /video/.test(mimetype) ? 'fa-file-video-o' : /text/.test(mimetype) ? 'fa-file-text-o' : 'fa-file-o';

/**
 * Documents (C-8): folder tree on the left (Company / My Drive / Recent /
 * Trash), the files of the selected folder as cards, upload (stored as
 * `ir.attachment` payloads), links, new folders, download, open and delete.
 */
export function Documents({ context, user }: { context: Record<string, unknown>; user?: SessionInfo }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const { navigate } = useNavigation();
  const [folders, setFolders] = useState<Rec[]>([]);
  const [section, setSection] = useState<Section>('company');
  const [folder, setFolder] = useState<number | null>(typeof context.folder_id === 'number' ? context.folder_id : null);
  const [docs, setDocs] = useState<Rec[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  const loadFolders = useCallback(async () => {
    const rows = await rpc<Rec[]>('searchRead', 'documents.document', { domain: [['is_folder', '=', true]], fields: ['name', 'folder_id', 'sequence'], order: 'sequence asc, name asc', limit: 500 }, { silent: true }).catch(() => []);
    setFolders(rows);
  }, []);
  const loadDocs = useCallback(async () => {
    const domain: unknown[] = [['is_folder', '=', false]];
    if (section === 'trash') domain.push(['active', '=', false]);
    if (section === 'mine') domain.push(['owner_id', '=', user?.uid ?? 0]);
    if (section !== 'recent' && section !== 'trash' && folder) domain.push(['folder_id', '=', folder]);
    if (search) domain.push(['name', 'ilike', search]);
    const rows = await rpc<Rec[]>('searchRead', 'documents.document', { domain, fields: ['name', 'mimetype', 'file_size', 'owner_id', 'partner_id', 'create_date', 'write_date', 'tag_ids', 'type', 'url', 'attachment_id', 'folder_id'], order: section === 'recent' ? 'write_date desc' : 'name asc', limit: section === 'recent' ? 40 : 200 }, { silent: true, context: section === 'trash' ? { active_test: false } : undefined }).catch(() => []);
    setDocs(rows);
  }, [section, folder, search, user?.uid]);
  useEffect(() => { void loadFolders(); }, [loadFolders]);
  useEffect(() => { void loadDocs(); }, [loadDocs]);

  const tree = useMemo(() => {
    const map = new Map<number, Folder>();
    for (const row of folders) map.set(Number(row.id), { id: Number(row.id), name: String(row.name), parent: idOf(row.folder_id), children: [] });
    const roots: Folder[] = [];
    for (const node of map.values()) { const parent = node.parent ? map.get(node.parent) : undefined; if (parent) parent.children.push(node); else roots.push(node); }
    return roots;
  }, [folders]);
  const tags = useMemo(() => { const m = new Map<number, string>(); for (const d of docs ?? []) for (const tg of (d.tag_ids as unknown[]) ?? []) if (Array.isArray(tg)) m.set(Number(tg[0]), String(tg[1])); return m; }, [docs]);
  const current = folders.find((f) => Number(f.id) === folder);
  const locale = lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US';

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > 5 * 1_048_576) { ui.notify({ type: 'warning', message: { en: `${file.name}: files over 5 MB are not supported yet.`, ar: `${file.name}: الملفات الأكبر من 5 ميغابايت غير مدعومة بعد.` } }); continue; }
      const datas = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const attachment = await rpc<number>('create', 'ir.attachment', { values: { name: file.name, datas, mimetype: file.type || 'application/octet-stream', file_size: file.size, type: 'binary', res_model: 'documents.document' } });
      await rpc('create', 'documents.document', { values: { name: file.name, attachment_id: attachment, folder_id: folder ?? false, type: 'binary', mimetype: file.type || 'application/octet-stream', file_size: file.size, owner_id: user?.uid ?? false } });
    }
    await loadDocs();
  };
  const addLink = () => {
    const url = window.prompt(t('URL'));
    if (!url) return;
    void rpc('create', 'documents.document', { values: { name: url.replace(/^https?:\/\//, '').slice(0, 60), url, type: 'url', folder_id: folder ?? false, owner_id: user?.uid ?? false } }).then(loadDocs);
  };
  const addFolder = () => {
    const name = window.prompt(t('Folder name'));
    if (!name) return;
    void rpc('create', 'documents.document', { values: { name, is_folder: true, type: 'folder', folder_id: folder ?? false, owner_id: user?.uid ?? false } }).then(loadFolders);
  };
  const remove = async (doc: Rec) => {
    if (section === 'trash') { if (!window.confirm(t('Delete permanently?'))) return; await rpc('unlink', 'documents.document', { ids: [Number(doc.id)] }); }
    else await rpc('write', 'documents.document', { ids: [Number(doc.id)], values: { active: false } });
    await loadDocs();
  };
  const restore = async (doc: Rec) => { await rpc('write', 'documents.document', { ids: [Number(doc.id)], values: { active: true } }, { context: { active_test: false } }); await loadDocs(); };
  const hrefOf = (doc: Rec) => (doc.type === 'url' ? String(doc.url ?? '#') : idOf(doc.attachment_id) ? `/api/attachment/${idOf(doc.attachment_id)}` : '#');

  const FolderNode = ({ node, depth }: { node: Folder; depth: number }) => (
    <div>
      <button type="button" className={`o_documents_folder ${folder === node.id && section === 'company' ? 'active' : ''}`} style={{ paddingInlineStart: 12 + depth * 14 }} onClick={() => { setSection('company'); setFolder(node.id); setOpen((s) => new Set(s).add(node.id)); }}>
        {node.children.length > 0 && <i className={`fa fa-caret-${open.has(node.id) ? 'down' : lang === 'ar_001' ? 'left' : 'right'} o_documents_caret`} onClick={(e) => { e.stopPropagation(); setOpen((s) => { const n = new Set(s); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); }} />}
        <i className="fa fa-folder-o me-2" />{node.name}
      </button>
      {open.has(node.id) && node.children.map((child) => <FolderNode key={child.id} node={child} depth={depth + 1} />)}
    </div>
  );

  return (
    <div className="o_documents">
      <aside className="o_documents_sidebar">
        <div className="p-2 d-grid gap-1">
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={section === 'trash'}><i className="fa fa-upload me-1" />{t('Upload')}</button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
          <div className="btn-group btn-group-sm">
            <button type="button" className="btn btn-secondary" onClick={addFolder}><i className="fa fa-folder me-1" />{t('Folder')}</button>
            <button type="button" className="btn btn-secondary" onClick={addLink}><i className="fa fa-link me-1" />{t('Link')}</button>
          </div>
        </div>
        {([['company', 'fa-building-o', 'Company'], ['mine', 'fa-hdd-o', 'My Drive'], ['recent', 'fa-clock-o', 'Recent'], ['trash', 'fa-trash-o', 'Trash']] as [Section, string, string][]).map(([key, icon, label]) => (
          <div key={key}>
            <button type="button" className={`o_documents_folder o_documents_section ${section === key && (key !== 'company' || folder === null) ? 'active' : ''}`} onClick={() => { setSection(key); if (key !== 'company') setFolder(null); else setFolder(null); }}><i className={`fa ${icon} me-2`} />{t(label)}</button>
            {key === 'company' && tree.map((node) => <FolderNode key={node.id} node={node} depth={1} />)}
          </div>
        ))}
      </aside>
      <section className="o_documents_content">
        <div className="o_documents_bar">
          <h5 className="m-0">{section === 'company' ? (current ? String(current.name) : t('Company')) : t(section === 'mine' ? 'My Drive' : section === 'recent' ? 'Recent' : 'Trash')}</h5>
          <div className="ms-auto o_searchview" style={{ maxWidth: 360 }}><i className="fa fa-search o_searchview_icon" /><input className="o_searchview_input" placeholder={t('Search...')} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        </div>
        <div className="o_documents_grid" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
          {docs === null && <div className="text-muted p-4">{t('Loading...')}</div>}
          {docs?.length === 0 && (
            <div className="o_documents_empty">
              <i className="fa fa-cloud-upload fa-3x mb-3" aria-hidden="true" />
              <div className="fw-bold">{t(section === 'trash' ? 'The trash is empty' : 'Drop files here or click Upload')}</div>
            </div>
          )}
          {docs?.map((doc) => (
            <div key={String(doc.id)} className={`o_documents_card ${selected === Number(doc.id) ? 'selected' : ''}`} onClick={() => setSelected(Number(doc.id))} onDoubleClick={() => navigate(`/odoo/m/documents.document/${doc.id}`)}>
              <div className="o_documents_preview"><i className={`fa ${iconOf(String(doc.mimetype ?? ''), String(doc.type ?? ''))}`} /></div>
              <div className="o_documents_body">
                <div className="o_documents_name" title={String(doc.name)}>{String(doc.name)}</div>
                <div className="small text-muted">{nameOf(doc.owner_id) || nameOf(doc.partner_id) || '—'} · {doc.file_size ? sizeOf(Number(doc.file_size)) : String(doc.type) === 'url' ? 'URL' : ''} · {doc.write_date ? new Date(String(doc.write_date).replace(' ', 'T') + 'Z').toLocaleDateString(locale) : ''}</div>
                {((doc.tag_ids as unknown[]) ?? []).length > 0 && <div className="mt-1">{((doc.tag_ids as unknown[]) ?? []).map((tg) => { const id = Array.isArray(tg) ? Number(tg[0]) : Number(tg); return <span key={id} className="badge rounded-pill text-bg-light me-1">{tags.get(id) ?? id}</span>; })}</div>}
              </div>
              <div className="o_documents_actions">
                {hrefOf(doc) !== '#' && <a className="btn btn-sm btn-link" href={hrefOf(doc)} target="_blank" rel="noreferrer" title={t('Download')} onClick={(e) => e.stopPropagation()}><i className={`fa ${doc.type === 'url' ? 'fa-external-link' : 'fa-download'}`} /></a>}
                <button type="button" className="btn btn-sm btn-link" title={t('Open')} onClick={(e) => { e.stopPropagation(); navigate(`/odoo/m/documents.document/${doc.id}`); }}><i className="fa fa-pencil" /></button>
                {section === 'trash'
                  ? <button type="button" className="btn btn-sm btn-link" title={t('Restore')} onClick={(e) => { e.stopPropagation(); void restore(doc); }}><i className="fa fa-undo" /></button>
                  : <button type="button" className="btn btn-sm btn-link text-danger" title={t('Move to trash')} onClick={(e) => { e.stopPropagation(); void remove(doc); }}><i className="fa fa-trash-o" /></button>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
