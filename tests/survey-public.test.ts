import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';

/**
 * The public survey (`app/survey/start/[token]`): a survey has a token to share,
 * every answer sheet has one of its own, and an answer is one
 * `survey.user_input.line` per question — which is what the reporting reads.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
}, 240_000);

afterAll(async () => { await db.close?.(); });

async function survey(): Promise<{ id: number; token: string; choice: number; text: number; answers: number[] }> {
  const surveys = env.model('survey.survey');
  const id = await surveys.create({ title: 'Customer Satisfaction' });
  const choice = await env.model('survey.question').create({
    survey_id: id, title: 'How did we do?', question_type: 'simple_choice', sequence: 1, constr_mandatory: true,
    suggested_answer_ids: [[0, 0, { value: 'Well' }], [0, 0, { value: 'Badly' }]],
  });
  const text = await env.model('survey.question').create({ survey_id: id, title: 'Anything else?', question_type: 'text_box', sequence: 2 });
  const [row] = await surveys.read(id, ['access_token']);
  const answers = await env.model('survey.question.answer').search([['question_id', '=', choice]]);
  return { id, token: String(row.access_token), choice, text, answers };
}

describe('public survey', () => {
  it('gives the survey a token to share and the answer sheet one of its own', async () => {
    const { id, token } = await survey();
    expect(token).toMatch(/^[a-z0-9]{24}$/);
    const input = await env.model('survey.user_input').create({ survey_id: id });
    const [sheet] = await env.model('survey.user_input').read(input, ['access_token', 'state']);
    expect(String(sheet.access_token)).toMatch(/^[a-z0-9]{24,}$/);
    expect(sheet.state).toBe('new');
    const second = await env.model('survey.user_input').create({ survey_id: id });
    expect((await env.model('survey.user_input').read(second, ['access_token']))[0].access_token).not.toBe(sheet.access_token);
  });

  it('records an answer the way the route does, one line per question', async () => {
    const { id, choice, text, answers } = await survey();
    const inputs = env.model('survey.user_input');
    const sheet = await inputs.create({ survey_id: id, nickname: 'Visitor', state: 'in_progress' });
    const lines = env.model('survey.user_input.line');
    await lines.create({ user_input_id: sheet, question_id: choice, question_sequence: 1, answer_type: 'suggestion', suggested_answer_id: answers[0] });
    await lines.create({ user_input_id: sheet, question_id: text, question_sequence: 2, answer_type: 'text_box', value_text_box: 'Keep it up' });
    await inputs.write(sheet, { state: 'done' });

    const recorded = await lines.searchRead([['user_input_id', '=', sheet]], ['question_id', 'answer_type', 'suggested_answer_id', 'value_text_box', 'skipped'], { order: 'question_sequence' });
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ answer_type: 'suggestion', skipped: false });
    expect(recorded[0].suggested_answer_id).toEqual([answers[0], 'Well']);
    expect(recorded[1]).toMatchObject({ answer_type: 'text_box', value_text_box: 'Keep it up' });
    expect((await inputs.read(sheet, ['state']))[0].state).toBe('done');
    // The survey's own counters see it.
    expect(await inputs.searchCount([['survey_id', '=', id], ['state', '=', 'done']])).toBe(1);
  });

  it('keeps a skipped question as a skipped line', async () => {
    const { id, text } = await survey();
    const sheet = await env.model('survey.user_input').create({ survey_id: id, state: 'in_progress' });
    await env.model('survey.user_input.line').create({ user_input_id: sheet, question_id: text, question_sequence: 2, skipped: true });
    const [line] = await env.model('survey.user_input.line').searchRead([['user_input_id', '=', sheet]], ['skipped', 'value_text_box']);
    expect(line).toMatchObject({ skipped: true });
  });

  it('counts the questions of the survey', async () => {
    const { id } = await survey();
    expect((await env.model('survey.survey').read(id, ['question_count']))[0].question_count).toBe(2);
  });
});
