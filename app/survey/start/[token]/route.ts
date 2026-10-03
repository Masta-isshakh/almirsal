import { NextResponse } from 'next/server';
import type { Environment } from '@engine/orm/env';
import { getPublicEnvironment } from '@/lib/server/public';
import { portalLang, tokenMatches } from '@/lib/server/portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/survey/start/<survey access token>` — the public survey: the questions as a form,
 * and the answers as a `survey.user_input` with one line per answer, the way
 * Odoo records them. A survey whose access mode is `token` needs an invitation
 * (`?answer=<user input token>`); a public one lets anybody start.
 *
 * The token in the link is the permission. No session is involved.
 */

const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tr = (rtl: boolean, en: string, ar: string): string => (rtl ? ar : en);

interface Opened { env: Environment; survey: Record<string, unknown>; answer: Record<string, unknown> | null }

async function openSurvey(token: string, answerToken: string | null, rtl: boolean): Promise<Opened | { error: 403 | 404 }> {
  const env = await getPublicEnvironment(rtl ? 'ar_001' : 'en_US');
  if (!env.registry.models['survey.survey']) return { error: 404 };
  const [survey] = await env.model('survey.survey').searchRead([['access_token', '=', token]], ['title', 'description', 'description_done', 'access_mode', 'question_and_page_ids', 'questions_layout', 'scoring_type'], { limit: 1 }).catch(() => []);
  if (!survey) return { error: 404 };
  let answer: Record<string, unknown> | null = null;
  if (answerToken) {
    const [found] = await env.model('survey.user_input').searchRead([['survey_id', '=', survey.id], ['access_token', '=', answerToken]], ['state', 'access_token', 'nickname', 'email'], { limit: 1 }).catch(() => []);
    if (!found || !tokenMatches(String(found.access_token ?? ''), answerToken)) return { error: 403 };
    answer = found;
  } else if (survey.access_mode === 'token') {
    // An invitation-only survey cannot be started from the link alone.
    return { error: 403 };
  }
  return { env, survey, answer };
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  const url = new URL(request.url);
  const rtl = (await portalLang(null, null, url, request)) === 'ar_001';
  const opened = await openSurvey(token, url.searchParams.get('answer'), rtl);
  if ('error' in opened) return new NextResponse(opened.error === 404 ? 'Not found' : 'This survey needs an invitation.', { status: opened.error });
  const { env, survey, answer } = opened;

  if (answer && answer.state === 'done') {
    return page(rtl, String(survey.title ?? ''), `
      <div class="o_survey_done">${String(survey.description_done ?? `<p>${esc(tr(rtl, 'Thank you, your answers are recorded.', 'شكراً لك، تم تسجيل إجاباتك.'))}</p>`)}</div>`);
  }

  const questions = await env.model('survey.question').read((survey.question_and_page_ids as number[]) ?? [], ['title', 'question_type', 'is_page', 'constr_mandatory', 'suggested_answer_ids', 'sequence', 'comments_allowed', 'constr_error_msg'])
    .then((rows) => rows.sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0)))
    .catch(() => []);
  const answerIds = questions.flatMap((question) => (question.suggested_answer_ids as number[]) ?? []);
  const suggestions = answerIds.length
    ? await env.model('survey.question.answer').read(answerIds, ['value', 'sequence']).catch(() => [])
    : [];
  const suggestionsOf = (question: Record<string, unknown>) => ((question.suggested_answer_ids as number[]) ?? [])
    .map((id) => suggestions.find((suggestion) => Number(suggestion.id) === id))
    .filter(Boolean) as Record<string, unknown>[];

  const body = questions.map((question) => {
    const name = `q${question.id}`;
    const required = question.constr_mandatory ? 'required' : '';
    if (question.is_page) return `<h2 class="o_survey_page">${esc(question.title)}</h2>`;
    const label = `<label class="o_survey_label" for="${name}">${esc(question.title)}${question.constr_mandatory ? ' <span class="o_survey_required">*</span>' : ''}</label>`;
    switch (question.question_type) {
      case 'simple_choice':
        return `<fieldset class="o_survey_question">${label}${suggestionsOf(question).map((suggestion) => `<label class="o_survey_choice"><input type="radio" name="${name}" value="${esc(suggestion.id)}" ${required} /> ${esc(suggestion.value)}</label>`).join('')}</fieldset>`;
      case 'multiple_choice':
        return `<fieldset class="o_survey_question">${label}${suggestionsOf(question).map((suggestion) => `<label class="o_survey_choice"><input type="checkbox" name="${name}" value="${esc(suggestion.id)}" /> ${esc(suggestion.value)}</label>`).join('')}</fieldset>`;
      case 'text_box':
        return `<div class="o_survey_question">${label}<textarea id="${name}" name="${name}" rows="4" ${required}></textarea></div>`;
      case 'numerical_box':
      case 'scale':
        return `<div class="o_survey_question">${label}<input id="${name}" name="${name}" type="number" step="any" ${required} /></div>`;
      case 'date':
        return `<div class="o_survey_question">${label}<input id="${name}" name="${name}" type="date" ${required} /></div>`;
      case 'datetime':
        return `<div class="o_survey_question">${label}<input id="${name}" name="${name}" type="datetime-local" ${required} /></div>`;
      default:
        return `<div class="o_survey_question">${label}<input id="${name}" name="${name}" type="text" ${required} /></div>`;
    }
  }).join('');

  const action = `/survey/start/${encodeURIComponent(token)}?${answer ? `answer=${encodeURIComponent(String(answer.access_token))}&` : ''}${rtl ? 'lang=ar_001' : ''}`;
  return page(rtl, String(survey.title ?? ''), `
    ${survey.description ? `<div class="o_survey_description">${String(survey.description)}</div>` : ''}
    <form method="post" action="${esc(action)}">
      ${answer ? '' : `<div class="o_survey_question"><label class="o_survey_label" for="nickname">${esc(tr(rtl, 'Your name', 'اسمك'))}</label><input id="nickname" name="nickname" type="text" /></div>`}
      ${body || `<p class="o_survey_empty">${esc(tr(rtl, 'This survey has no question yet.', 'لا يحتوي هذا الاستبيان على أسئلة بعد.'))}</p>`}
      <button type="submit">${esc(tr(rtl, 'Submit', 'إرسال'))}</button>
    </form>`);
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  const url = new URL(request.url);
  const rtl = (await portalLang(null, null, url, request)) === 'ar_001';
  const opened = await openSurvey(token, url.searchParams.get('answer'), rtl);
  if ('error' in opened) return new NextResponse('This survey needs an invitation.', { status: opened.error });
  const { env, survey } = opened;
  let answer = opened.answer;
  if (answer && answer.state === 'done') return NextResponse.redirect(new URL(url.pathname + url.search, url), 303);

  const form = await request.formData();
  const inputs = env.model('survey.user_input');
  if (!answer) {
    const created = await inputs.create({
      survey_id: survey.id,
      nickname: String(form.get('nickname') ?? '').trim().slice(0, 80) || false,
      state: 'in_progress',
    });
    answer = (await inputs.read(created, ['access_token', 'state']))[0];
  }
  const answerId = Number(answer!.id);

  const questions = await env.model('survey.question').read((survey.question_and_page_ids as number[]) ?? [], ['question_type', 'is_page', 'sequence', 'suggested_answer_ids']).catch(() => []);
  const lines = env.model('survey.user_input.line');
  for (const question of questions) {
    if (question.is_page) continue;
    const key = `q${question.id}`;
    const values = form.getAll(key).map((value) => String(value)).filter((value) => value.trim() !== '');
    const base = { user_input_id: answerId, question_id: question.id, question_sequence: question.sequence ?? 0 };
    if (!values.length) {
      await lines.create({ ...base, skipped: true, answer_type: false }).catch(() => undefined);
      continue;
    }
    switch (question.question_type) {
      case 'simple_choice':
      case 'multiple_choice':
        for (const value of values) {
          const suggested = Number(value);
          // Only an answer this question offers is recorded.
          if (!((question.suggested_answer_ids as number[]) ?? []).includes(suggested)) continue;
          await lines.create({ ...base, answer_type: 'suggestion', suggested_answer_id: suggested }).catch(() => undefined);
        }
        break;
      case 'text_box':
        await lines.create({ ...base, answer_type: 'text_box', value_text_box: values[0].slice(0, 4000) }).catch(() => undefined);
        break;
      case 'numerical_box':
      case 'scale':
        await lines.create({ ...base, answer_type: 'numerical_box', value_numerical_box: Number(values[0]) || 0 }).catch(() => undefined);
        break;
      case 'date':
        await lines.create({ ...base, answer_type: 'date', value_date: values[0].slice(0, 10) }).catch(() => undefined);
        break;
      case 'datetime':
        await lines.create({ ...base, answer_type: 'datetime', value_datetime: values[0].replace('T', ' ').slice(0, 19) }).catch(() => undefined);
        break;
      default:
        await lines.create({ ...base, answer_type: 'char_box', value_char_box: values[0].slice(0, 240) }).catch(() => undefined);
    }
  }
  await inputs.write(answerId, { state: 'done' });

  const done = new URL(url.pathname, url);
  done.searchParams.set('answer', String(answer!.access_token ?? ''));
  if (rtl) done.searchParams.set('lang', 'ar_001');
  return NextResponse.redirect(done, 303);
}

function page(rtl: boolean, title: string, inner: string): Response {
  const body = `<!DOCTYPE html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700&family=Noto+Sans+Arabic:wght@400;500;700&display=swap" />
<style>${SURVEY_CSS}</style>
</head>
<body>
<main class="o_survey_card">
  <h1>${esc(title)}</h1>
  ${inner}
</main>
</body>
</html>`;
  return new NextResponse(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const SURVEY_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f4f6; font-family: "Noto Sans", "Noto Sans Arabic", system-ui, sans-serif; color: #111827; }
  .o_survey_card { background: #fff; max-width: 680px; width: calc(100% - 32px); margin: 32px auto; padding: 28px 32px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.12); }
  h1 { font-size: 22px; margin: 0 0 12px; }
  h2.o_survey_page { font-size: 16px; margin: 24px 0 8px; color: #714b67; }
  .o_survey_description, .o_survey_done { color: #4b5563; }
  .o_survey_question { margin: 0 0 18px; border: 0; padding: 0; }
  .o_survey_label { display: block; font-weight: 500; margin-bottom: 6px; }
  .o_survey_required { color: #dc2626; }
  .o_survey_choice { display: block; margin: 4px 0; font-weight: 400; }
  .o_survey_card input[type=text], .o_survey_card input[type=number], .o_survey_card input[type=date], .o_survey_card input[type=datetime-local], .o_survey_card textarea {
    width: 100%; border: 1px solid #d1d5db; border-radius: 4px; padding: 9px 12px; font: inherit;
  }
  .o_survey_empty { color: #6b7280; }
  .o_survey_card button { background: #714b67; color: #fff; border: 0; border-radius: 4px; padding: 10px 22px; font: inherit; font-weight: 700; cursor: pointer; }
`;
