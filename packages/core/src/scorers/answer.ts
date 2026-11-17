import { Ajv } from 'ajv';
import { answerText, na, type Scorer } from './util.js';

/** Final-answer checks: exact, contains, regex, JSON schema. (Semantic checks use the judge scorer.) */
export const answerScorer: Scorer = {
  name: 'answer_checks',
  score({ case: c, run }) {
    const a = c.expected?.answer;
    if (!a || (a.exact === undefined && !a.contains && !a.not_contains && !a.regex && !a.json_schema)) return na('answer_checks');
    const text = answerText(run);
    const fails: string[] = [];
    let total = 0;
    const check = (ok: boolean, msg: string) => {
      total++;
      if (!ok) fails.push(msg);
    };
    if (a.exact !== undefined) check(text.trim() === a.exact.trim(), `answer is not exactly "${a.exact}"`);
    for (const s of a.contains ?? []) check(text.toLowerCase().includes(s.toLowerCase()), `answer does not contain "${s}"`);
    for (const s of a.not_contains ?? []) check(!text.toLowerCase().includes(s.toLowerCase()), `answer contains forbidden "${s}"`);
    if (a.regex) check(new RegExp(a.regex, 'i').test(text), `answer does not match /${a.regex}/`);
    if (a.json_schema) {
      let ok: boolean;
      try {
        const v = typeof run.output === 'string' ? JSON.parse(run.output) : run.output;
        const validate = new Ajv({ allErrors: true, strict: false }).compile(a.json_schema);
        ok = validate(v) as boolean;
      } catch {
        ok = false;
      }
      check(ok, 'answer does not satisfy the JSON schema');
    }
    return { name: 'answer_checks', score: (total - fails.length) / total, pass: !fails.length, details: fails.join('; ') || undefined };
  },
};
