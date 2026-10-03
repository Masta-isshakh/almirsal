/**
 * Odoo's naming, read as stems. A smart button named `action_view_invoice` and
 * a counter named `invoice_count` both name the same thing, and the name is
 * often a plural or a nickname of the model it points at (`cars` for
 * `fleet.vehicle`, `sols` for `sale.order.line`), so both the button resolver
 * and the counters resolve a name to the stems it may mean.
 */

export const BUTTON_PREFIXES = ['action_view_', 'action_open_', 'button_open_', 'action_see_', 'open_', 'action_', 'button_'];

const STOP = new Set(['view', 'all', 'related', 'linked', 'ids', 'id', 'the', 'of', 'to', 'from', 'stat']);

/** Stems a name may use for a target, in the order they are tried. */
export const STEM_ALIASES: Record<string, string[]> = {
  sos: ['sale_order', 'sale'], so: ['sale_order', 'sale'], sols: ['sale_order_line', 'sale_line'], sol: ['sale_order_line'],
  po: ['purchase_order', 'purchase'], pos: ['purchase_order', 'purchase'], bills: ['invoice', 'move', 'bill'], bill: ['invoice', 'move'],
  invoices: ['invoice', 'move'], invoice: ['invoice', 'move'], entries: ['move', 'entry'], entry: ['move'], items: ['move_line', 'line'],
  cars: ['vehicle', 'car'], car: ['vehicle'], vehicles: ['vehicle'], signatures: ['sign_request', 'sign'], requests: ['request'],
  documents: ['document', 'attachment'], document: ['document', 'attachment'], attachment: ['attachment', 'document'],
  employees: ['employee'], employee: ['employee'], tasks: ['task'], task: ['task'], tickets: ['ticket'], ticket: ['ticket'],
  planning: ['planning_slot', 'slot', 'planning'], slots: ['planning_slot', 'slot'], meetings: ['calendar_event', 'meeting', 'event'], calendar: ['calendar_event', 'event'],
  contacts: ['partner', 'contact'], contact: ['partner'], partner: ['partner'], users: ['user'], user: ['user'],
  certifications: ['resume_line', 'certification'], versions: ['version'], assets: ['asset'], loans: ['loan'], payments: ['payment'], refunds: ['refund', 'payment'],
  ratings: ['rating'], rating: ['rating'], odometer: ['odometer'], services: ['service'], contracts: ['contract'], models: ['model'], brand: ['brand'],
  subtasks: ['child', 'subtask'], parent: ['parent'], attempts: ['user_input'], badges: ['badge'], goals: ['goal'], answers: ['answer'],
  accounts: ['account'], taxes: ['tax'], journals: ['journal'], products: ['product'], rentals: ['rental', 'sale_order_line'],
  transactions: ['transaction'], tokens: ['token'], stats: ['stat'], types: ['type'], lines: ['line'], increase: ['increase', 'child'], assignation: ['assignation'],
};

/** The stems a button or counter name may mean, best first. */
export function stemsOf(name: string): string[] {
  let rest = name;
  for (const prefix of BUTTON_PREFIXES) if (rest.startsWith(prefix)) { rest = rest.slice(prefix.length); break; }
  const words = rest.split('_').filter((word) => word && !STOP.has(word));
  const out: string[] = [];
  const joined = words.join('_');
  if (joined) out.push(joined);
  for (const word of words) { out.push(word); for (const alias of STEM_ALIASES[word] ?? []) out.push(alias); }
  // singular forms
  for (const word of [...out]) { if (word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`); else if (word.endsWith('s')) out.push(word.slice(0, -1)); }
  return [...new Set(out)];
}
