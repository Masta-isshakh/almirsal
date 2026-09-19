/**
 * Draws the 22 app icons as flat SVGs from the B-5 descriptions: a 70×70
 * white rounded square (radius 6) with a 2–3 colour glyph. Output goes to
 * public/icons/apps/<slug>.svg. Run: npx tsx scripts/generate-icons.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const P = '#714B67'; // purple
const T = '#017E84'; // teal
const O = '#F18E42'; // orange
const OD = '#EB5B25';
const PK = '#D6145F';
const BL = '#6CC1ED';
const GR = '#30C381';
const YL = '#F7CD1F';
const RD = '#F06050';
const BR = '#8C564B';

const frame = (body: string, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 70" width="70" height="70">${defs ? `<defs>${defs}</defs>` : ''}<rect width="70" height="70" rx="6" fill="#fff"/>${body}</svg>`;

const icons: Record<string, string> = {
  discuss: frame(
    `<path d="M35 12c12 0 21 8 21 18s-9 18-21 18c-2 0-4 0-6-1l-11 6 3-9c-4-4-7-9-7-14 0-10 9-18 21-18z" fill="url(#g)"/><circle cx="27" cy="30" r="2.5" fill="#fff"/><circle cx="35" cy="30" r="2.5" fill="#fff"/><circle cx="43" cy="30" r="2.5" fill="#fff"/>`,
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${O}"/><stop offset="1" stop-color="${OD}"/></linearGradient>`,
  ),
  calendar: frame(
    `<rect x="12" y="16" width="46" height="42" rx="5" fill="${P}"/><rect x="12" y="16" width="46" height="12" rx="5" fill="url(#g)"/><rect x="12" y="22" width="46" height="6" fill="url(#g)"/><text x="35" y="50" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">31</text>`,
    `<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${O}"/><stop offset="1" stop-color="${OD}"/></linearGradient>`,
  ),
  appointments: frame(
    `<rect x="12" y="16" width="46" height="42" rx="5" fill="${P}"/><rect x="12" y="16" width="46" height="12" rx="5" fill="${T}"/><rect x="12" y="22" width="46" height="6" fill="${T}"/><text x="30" y="50" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#fff" text-anchor="middle">31</text><circle cx="50" cy="48" r="8" fill="${GR}"/><path d="M46 48l3 3 5-6" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  todo: frame(
    `<path d="M18 46l26-26 6 6-26 26H18z" fill="${T}"/><path d="M44 20l6 6 4-4a3 3 0 0 0 0-4l-2-2a3 3 0 0 0-4 0z" fill="${P}"/><path d="M18 46l3 3-5 2z" fill="#333"/>`,
  ),
  knowledge: frame(
    `<path d="M22 12h26v46l-13-9-13 9z" fill="${P}"/><path d="M22 12h13v37l-13 9z" fill="${T}"/>`,
  ),
  sales: frame(
    `<rect x="14" y="36" width="10" height="20" rx="2" fill="${P}"/><rect x="30" y="24" width="10" height="32" rx="2" fill="${O}"/><rect x="46" y="14" width="10" height="42" rx="2" fill="${PK}"/>`,
  ),
  dashboards: frame(
    `<rect x="14" y="14" width="18" height="18" rx="3" fill="${P}"/><rect x="38" y="14" width="18" height="18" rx="3" fill="${PK}"/><rect x="14" y="38" width="18" height="18" rx="3" fill="${BL}"/><rect x="38" y="38" width="18" height="18" rx="3" fill="${P}" opacity=".55"/>`,
  ),
  rental: frame(
    `<circle cx="26" cy="30" r="12" fill="${T}"/><circle cx="26" cy="30" r="4.5" fill="#fff"/><path d="M34 34l22 20-4 4-5-5-4 4-4-4 4-4-4-4-4 4-5-5z" fill="${P}"/>`,
  ),
  accounting: frame(
    `<path d="M20 52L50 18" stroke="${P}" stroke-width="6" stroke-linecap="round"/><circle cx="23" cy="22" r="7" fill="${T}"/><circle cx="47" cy="48" r="7" fill="${T}"/>`,
  ),
  documents: frame(
    `<rect x="14" y="26" width="28" height="34" rx="3" fill="${PK}"/><rect x="21" y="18" width="28" height="34" rx="3" fill="${O}"/><rect x="28" y="10" width="28" height="34" rx="3" fill="${BL}"/>`,
  ),
  project: frame(
    `<path d="M14 38l14 14 28-30" stroke="${T}" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  planning: frame(
    `<path d="M14 26h30l-8-8" stroke="${P}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M56 44H26l8 8" stroke="${T}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M52 14c5 6 5 10 0 10s-5-4 0-10z" fill="${T}"/>`,
  ),
  helpdesk: frame(
    `<rect x="29" y="14" width="12" height="42" rx="3" fill="${T}"/><rect x="14" y="29" width="42" height="12" rx="3" fill="${T}"/>`,
  ),
  surveys: frame(
    `<rect x="14" y="30" width="10" height="26" rx="2" fill="${BL}"/><rect x="30" y="16" width="10" height="40" rx="2" fill="${RD}"/><rect x="46" y="38" width="10" height="18" rx="2" fill="${BL}"/>`,
  ),
  purchase: frame(
    `<rect x="12" y="20" width="46" height="30" rx="4" fill="${P}"/><rect x="12" y="27" width="46" height="7" fill="${T}"/><rect x="18" y="40" width="14" height="4" rx="1" fill="#fff"/>`,
  ),
  sign: frame(
    `<path d="M14 46c8-14 12-18 16-10s6 10 12-2 8-10 14 0" stroke="${T}" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M14 54h42" stroke="${BL}" stroke-width="3" stroke-linecap="round"/>`,
  ),
  employees: frame(
    `<circle cx="24" cy="26" r="8" fill="${P}"/><path d="M10 54c0-10 6-16 14-16s14 6 14 16z" fill="${P}"/><circle cx="46" cy="24" r="8" fill="${T}"/><path d="M32 52c0-10 6-16 14-16s14 6 14 16z" fill="${T}"/><circle cx="35" cy="18" r="5" fill="${YL}"/>`,
  ),
  attendances: frame(
    `<circle cx="28" cy="24" r="9" fill="${O}"/><path d="M12 56c0-12 7-18 16-18s16 6 16 18z" fill="${BR}"/><circle cx="50" cy="46" r="10" fill="#fff" stroke="${O}" stroke-width="3"/><path d="M50 40v6l4 3" stroke="${O}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
  ),
  fleet: frame(
    `<circle cx="35" cy="35" r="21" fill="none" stroke="${P}" stroke-width="6"/><circle cx="35" cy="35" r="6" fill="${P}"/><path d="M35 17v12M17 35h12M41 41l10 10" stroke="${P}" stroke-width="5" stroke-linecap="round"/>`,
  ),
  approvals: frame(
    `<circle cx="26" cy="24" r="9" fill="${P}"/><path d="M10 56c0-12 7-18 16-18s16 6 16 18z" fill="${P}"/><circle cx="50" cy="44" r="11" fill="${T}"/><path d="M44 44l4 4 8-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  apps: frame(
    `<path d="M35 12a23 23 0 0 1 23 23H35z" fill="${P}"/><path d="M35 12v23H12a23 23 0 0 1 23-23z" fill="${T}"/><path d="M12 35h23v23a23 23 0 0 1-23-23z" fill="${RD}"/><path d="M35 35h23a23 23 0 0 1-23 23z" fill="${BL}"/>`,
  ),
  settings: frame(
    `<path d="M35 10l21 12v24L35 58 14 46V22z" fill="${O}"/><circle cx="35" cy="34" r="9" fill="#fff"/>`,
  ),
};

const out = resolve(process.cwd(), 'public/icons/apps');
mkdirSync(out, { recursive: true });
for (const [slug, svg] of Object.entries(icons)) writeFileSync(resolve(out, `${slug}.svg`), svg);
console.log(`wrote ${Object.keys(icons).length} icons to ${out}`);
