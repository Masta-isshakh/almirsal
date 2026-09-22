import { evaluate, makeScope } from '../../packages/engine/expr/evaluate.js';
const scope = makeScope({ uid: 2, allowedCompanyIds: [1], context: {}, strictNames: false, extra: { self: 'x', raw_value: 'x' } });
console.log(JSON.stringify(evaluate(`[ ('start_date', '<=', "2026-01-01"), ('return_date', '>=', "2026-01-01"), ]`, scope)));
console.log(JSON.stringify(evaluate(`[ ('start_date', '<=', raw_value), ]`, scope)));
const src = "[ ('start_date', '<=', raw_value), ('return_date', '>=', raw_value), ]";
console.log(src.replace(/(self|raw_value)/g, JSON.stringify('2026-01-01')));
