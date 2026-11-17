import { answerText, na, retrievals, type Scorer } from './util.js';

const CITE = /\[([A-Za-z0-9_.:-]+)\]/g;
const QUOTE = /["“]([^"”]{12,})["”]\s*\[([A-Za-z0-9_.:-]+)\]/g;

/**
 * Deterministic groundedness / citation accuracy:
 *  1. every cited id exists in the retrieved set;
 *  2. every quoted span followed by a citation appears in the cited chunk (when chunk text is available).
 * Score = fraction of checks passed.
 */
export const citationScorer: Scorer = {
  name: 'citation_accuracy',
  score({ case: c, run, chunkText }) {
    if (!c.expected?.citations) return na('citation_accuracy');
    const text = answerText(run);
    const retrieved = new Set(retrievals(run).flatMap((r) => r.results.map((x) => x.id)));
    const cited = [...text.matchAll(CITE)].map((m) => m[1]);
    const fails: string[] = [];
    let total = 0;
    if (!cited.length) {
      return { name: 'citation_accuracy', score: 0, pass: false, details: 'answer has no citations' };
    }
    for (const id of new Set(cited)) {
      total++;
      if (!retrieved.has(id)) fails.push(`cited [${id}] was not retrieved`);
    }
    let skipped = 0;
    for (const m of text.matchAll(QUOTE)) {
      const t = chunkText(m[2]);
      if (t === undefined) {
        skipped++;
        continue;
      }
      total++;
      const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
      if (!norm(t).includes(norm(m[1]))) fails.push(`quote "${m[1].slice(0, 40)}..." not found in [${m[2]}]`);
    }
    const d = [...fails, skipped ? `${skipped} quote(s) not checked (no chunk text)` : ''].filter(Boolean).join('; ');
    return { name: 'citation_accuracy', score: (total - fails.length) / total, pass: !fails.length, details: d || undefined };
  },
};
