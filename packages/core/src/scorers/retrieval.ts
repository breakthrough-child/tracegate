import { na, retrievals, type Scorer } from './util.js';

export const recallAtK = (ranked: string[], gold: string[], k: number): number =>
  gold.length ? gold.filter((g) => ranked.slice(0, k).includes(g)).length / gold.length : NaN;
export const precisionAtK = (ranked: string[], gold: string[], k: number): number => {
  const top = ranked.slice(0, k);
  return top.length ? top.filter((r) => gold.includes(r)).length / k : 0;
};
/** Reciprocal rank of the first relevant result (0 if none). */
export const mrr = (ranked: string[], gold: string[]): number => {
  const i = ranked.findIndex((r) => gold.includes(r));
  return i < 0 ? 0 : 1 / (i + 1);
};
/** nDCG@k with gain / log2(rank+1). Binary gains unless `gains` is given. */
export function ndcgAtK(ranked: string[], gold: string[], k: number, gains?: Record<string, number>): number {
  const g = (id: string) => (gains ? (gains[id] ?? 0) : gold.includes(id) ? 1 : 0);
  const dcg = ranked.slice(0, k).reduce((s, id, i) => s + g(id) / Math.log2(i + 2), 0);
  const ideal = (gains ? Object.values(gains) : gold.map(() => 1)).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
  return idcg ? dcg / idcg : NaN;
}

/** Produces recall@k, precision@k, MRR and nDCG@k from the first retrieval event against gold ids. */
export const retrievalScorer: Scorer = {
  name: 'retrieval',
  score({ case: c, run }) {
    const r = c.expected?.retrieval;
    if (!r) return [na('retrieval_recall'), na('retrieval_precision'), na('retrieval_mrr'), na('retrieval_ndcg')];
    const k = r.k ?? 5;
    const ranked: string[] = [];
    for (const ev of retrievals(run)) for (const x of ev.results) if (!ranked.includes(x.id)) ranked.push(x.id);
    const rec = recallAtK(ranked, r.gold, k);
    const mk = (name: string, score: number, required = false) => ({ name, score, pass: required ? score >= 1 : true, required });
    return [
      mk('retrieval_recall', rec, true),
      mk('retrieval_precision', precisionAtK(ranked, r.gold, k)),
      mk('retrieval_mrr', mrr(ranked, r.gold)),
      mk('retrieval_ndcg', ndcgAtK(ranked, r.gold, k, r.gains)),
    ];
  },
};
