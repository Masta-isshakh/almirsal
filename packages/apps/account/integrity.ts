import { createHash } from 'node:crypto';
import type { Environment } from '../../engine/orm/env.js';
import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import { UserError } from '../../engine/orm/errors.js';
import { addDays, m2o, notify } from '../common.js';

const LOCKS = ['fiscalyear_lock_date','sale_lock_date','purchase_lock_date','tax_lock_date','hard_lock_date'];
const MOVE_FIELDS = ['name','date','journal_id','company_id','currency_id','partner_id','move_type','invoice_line_ids','line_ids','invoice_date','invoice_payment_term_id','fiscal_position_id'];
const LINE_FIELDS = ['move_id','account_id','partner_id','name','debit','credit','balance','amount_currency','currency_id','date','date_maturity','quantity','price_unit','discount','tax_ids','display_type'];

async function lockDate(env: Environment, move: Values): Promise<string> {
  const companyId = m2o(move.company_id) || env.companyId;
  const company = (await env.model('res.company').read(companyId, LOCKS))[0];
  const fields = ['fiscalyear_lock_date','hard_lock_date'];
  if (String(move.move_type).startsWith('out')) fields.push('sale_lock_date');
  if (String(move.move_type).startsWith('in')) fields.push('purchase_lock_date');
  const rel = env.registry.models['account.move.line'].fields.tax_ids;
  if (move.id && (await env.cr.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM account_move_line l
    WHERE l.move_id=$1 AND (l.tax_line_id IS NOT NULL OR EXISTS (SELECT 1 FROM "${rel.m2mTable}" r WHERE r."${rel.m2mColumn1}"=l.id))) AS exists`, [move.id])).rows[0].exists) fields.push('tax_lock_date');
  const exceptions = (await env.cr.query<{ lock_date_field: string; lock_date: string | null }>(`SELECT lock_date_field, lock_date::text FROM account_lock_exception
    WHERE company_id=$1 AND state='active' AND (user_id IS NULL OR user_id=$2) AND (end_datetime IS NULL OR end_datetime>now())`, [companyId,env.uid])).rows;
  return fields.map(field => {
    const overrides = field==='hard_lock_date' ? [] : exceptions.filter(e => e.lock_date_field===field);
    return overrides.length ? overrides.reduce((min,e) => e.lock_date && min && e.lock_date>min ? min : e.lock_date || '', String(company[field] || '')) : String(company[field] || '');
  }).sort().at(-1) || '';
}

/** Closed periods retain their history; new entries move to the next open date. */
export async function postingDate(env: Environment, move: Values, requested: string): Promise<string> {
  const date = requested.slice(0,10);
  const locked = await lockDate(env, move);
  return locked && date<=locked ? addDays(locked,1) : date;
}

async function payload(env: Environment, id: number): Promise<string> {
  const [move] = (await env.cr.query<Record<string,unknown>>(`SELECT id,name,date::text,journal_id,company_id,currency_id,partner_id,move_type,secure_sequence_number FROM account_move WHERE id=$1`,[id])).rows;
  const lines = (await env.cr.query<Record<string,unknown>>(`SELECT id,account_id,partner_id,name,debit::text,credit::text,amount_currency::text,currency_id,date::text,date_maturity::text
    FROM account_move_line WHERE move_id=$1 ORDER BY id`,[id])).rows;
  return JSON.stringify({ move,lines });
}

async function hashEntries(env: Environment, ids: number[]): Promise<void> {
  const selected = await env.model('account.move').read(ids,['state','journal_id']);
  if (selected.some(m => m.state!=='posted')) throw new UserError({ en: 'Only posted entries can be secured.', ar: 'يمكن تأمين القيود المرحّلة فقط.' });
  const journals = [...new Set(selected.map(m => Number(m2o(m.journal_id))))].sort((a,b) => a-b);
  for (const journal of journals) {
    await env.cr.query(`SELECT id FROM account_journal WHERE id=$1 FOR UPDATE`,[journal]);
    const last = (await env.cr.query<{ hash: string; n: number }>(`SELECT inalterable_hash AS hash,secure_sequence_number AS n FROM account_move
      WHERE journal_id=$1 AND secure_sequence_number IS NOT NULL ORDER BY secure_sequence_number DESC LIMIT 1`,[journal])).rows[0];
    let previous = last?.hash || ''; let sequence = Number(last?.n || 0);
    const moves = (await env.cr.query<{ id: number }>(`SELECT id FROM account_move WHERE journal_id=$1 AND state='posted' AND coalesce(inalterable_hash,'')=''
      AND id<=(SELECT max(id) FROM account_move WHERE id=ANY($2) AND journal_id=$1) ORDER BY id FOR UPDATE`,[journal,ids])).rows;
    for (const move of moves) {
      await env.cr.query(`UPDATE account_move SET secure_sequence_number=$2 WHERE id=$1`,[move.id,++sequence]);
      previous = createHash('sha256').update(previous+'\n'+await payload(env,move.id)).digest('hex');
      await env.cr.query(`UPDATE account_move SET inalterable_hash=$2 WHERE id=$1`,[move.id,previous]);
    }
  }
}

export async function verifyJournalHashes(env: Environment, journal: number): Promise<boolean> {
  await env.model('account.journal').read(journal,['id']);
  const moves = (await env.cr.query<{ id: number; hash: string; n: number }>(`SELECT id,inalterable_hash AS hash,secure_sequence_number AS n FROM account_move
    WHERE journal_id=$1 AND secure_sequence_number IS NOT NULL ORDER BY secure_sequence_number`,[journal])).rows;
  let previous=''; let sequence=0;
  for (const move of moves) {
    if (Number(move.n)!==++sequence) return false;
    const expected=createHash('sha256').update(previous+'\n'+await payload(env,move.id)).digest('hex');
    if (expected!==move.hash) return false;
    previous=expected;
  }
  return true;
}

async function protectLines(env: Environment, moveIds: number[]): Promise<void> {
  if (!moveIds.length) return;
  const moves=await env.model('account.move').read(moveIds,['state','inalterable_hash']);
  if (moves.some(m => m.state==='posted' || m.inalterable_hash)) throw new UserError({ en: 'Reset the journal entry to draft before changing its journal items. Secured entries cannot be changed.', ar: 'أعد القيد إلى المسودة قبل تعديل بنوده. لا يمكن تعديل القيود المؤمّنة.' });
}

export function registerAccountIntegrity(): void {
  registerModelHooks('account.move', {
    noCopy: ['inalterable_hash','secure_sequence_number'],
    beforeCreate: (_env,vals) => {
      if (vals.state==='posted' || vals.inalterable_hash || vals.secure_sequence_number) throw new UserError({ en: 'Create a draft entry and use Post to validate it.', ar: 'أنشئ قيداً مسودة ثم استخدم الترحيل للتحقق منه.' });
      return vals;
    },
    beforeWrite: async (env,ids,vals) => {
      if ('inalterable_hash' in vals || 'secure_sequence_number' in vals) throw new UserError({ en: 'Use Secure Entries to assign integrity hashes.', ar: 'استخدم تأمين القيود لإسناد تجزئة السلامة.' });
      const moves=await env.model('account.move').read(ids,['state','inalterable_hash','company_id','move_type','date']);
      const financial=MOVE_FIELDS.some(f => f in vals);
      for (const move of moves) {
        if (move.inalterable_hash && (financial || 'state' in vals || 'inalterable_hash' in vals || 'secure_sequence_number' in vals)) throw new UserError({ en: 'This entry is secured and cannot be changed.', ar: 'هذا القيد مؤمّن ولا يمكن تعديله.' });
        if (move.state==='posted' && financial) throw new UserError({ en: 'Reset the entry to draft before changing its financial details.', ar: 'أعد القيد إلى المسودة قبل تعديل تفاصيله المالية.' });
        if (vals.state==='posted') {
          const check=(await env.cr.query<{ n: number; balance: number; missing: number; name: string }>(`SELECT m.name,
            count(l.id)::int AS n,coalesce(sum(l.debit-l.credit),0)::float8 AS balance,
            count(l.id) FILTER (WHERE l.account_id IS NULL AND coalesce(l.display_type,'product') NOT IN ('line_section','line_note'))::int AS missing
            FROM account_move m LEFT JOIN account_move_line l ON l.move_id=m.id WHERE m.id=$1 GROUP BY m.name`,[move.id])).rows[0];
          if (!check.n || check.missing || Math.abs(check.balance)>.005 || !check.name || check.name==='/') throw new UserError({ en: 'Use Post to validate a numbered, balanced entry with accounts on every item.', ar: 'استخدم الترحيل للتحقق من قيد مرقّم ومتوازن بحساب لكل بند.' });
          const locked=await lockDate(env,move);
          if (locked && String(vals.date || move.date)<=locked) throw new UserError({ en: 'Use Post to select the next open accounting date.', ar: 'استخدم الترحيل لاختيار تاريخ محاسبي مفتوح.' });
        }
        if (move.state==='posted' && 'state' in vals && vals.state!=='posted') {
          const locked=await lockDate(env,move);
          if (locked && String(move.date)<=locked) throw new UserError({ en: 'This entry belongs to a locked accounting period.', ar: 'هذا القيد يخص فترة محاسبية مقفلة.' });
          const matched=(await env.cr.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM account_partial_reconcile p JOIN account_move_line l
            ON l.id=p.debit_move_id OR l.id=p.credit_move_id WHERE l.move_id=$1) AS exists`,[move.id])).rows[0].exists;
          if (matched) throw new UserError({ en: 'Remove the reconciliations before resetting or cancelling this entry.', ar: 'أزل التسويات قبل إعادة القيد إلى المسودة أو إلغائه.' });
        }
      }
      return vals;
    },
    onWrite: async (env,ids,vals) => {
      if (vals.state!=='posted') return;
      const rows=(await env.cr.query<{ id: number }>(`SELECT m.id FROM account_move m JOIN account_journal j ON j.id=m.journal_id
        WHERE m.id=ANY($1) AND j.restrict_mode_hash_table=true`,[ids])).rows;
      if (rows.length) await hashEntries(env,rows.map(r => Number(r.id)));
    },
    methods: { button_hash: async (env,ids) => { await hashEntries(env,ids); return notify({ en: 'Entries secured with a SHA-256 hash chain.', ar: 'تم تأمين القيود بسلسلة تجزئة SHA-256.' }); } },
  });
  registerModelHooks('account.move.line', {
    beforeCreate: async (env,vals) => { const move=m2o(vals.move_id); if (move) await protectLines(env,[move]); return vals; },
    beforeWrite: async (env,ids,vals) => {
      if (LINE_FIELDS.some(f => f in vals)) {
        const lines=await env.model('account.move.line').read(ids,['move_id']);
        await protectLines(env,[...new Set([...lines.map(l => Number(m2o(l.move_id))),...(m2o(vals.move_id) ? [Number(m2o(vals.move_id))] : [])])]);
      }
      return vals;
    },
    onUnlink: async (env,ids) => { const rows=await env.model('account.move.line').read(ids,['move_id']); await protectLines(env,[...new Set(rows.map(l => Number(m2o(l.move_id))))]); },
  });
  registerModelHooks('res.company', {
    beforeWrite: async (env,ids,vals) => {
      if ('hard_lock_date' in vals) for (const company of await env.model('res.company').read(ids,['hard_lock_date'])) {
        if (company.hard_lock_date && (!vals.hard_lock_date || String(vals.hard_lock_date)<String(company.hard_lock_date))) throw new UserError({ en: 'The hard lock date cannot be moved backwards.', ar: 'لا يمكن إرجاع تاريخ القفل الثابت إلى الخلف.' });
      }
      return vals;
    },
  });
}
