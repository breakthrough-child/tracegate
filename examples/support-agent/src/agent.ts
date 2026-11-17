import { wrapAnthropic } from '@tracegate/adapters';
import type { AgentContext, Case } from '@tracegate/core';
import { ORDERS, searchKb } from './data.js';
import { createMockLLM } from './mock-llm.js';

export type Variant = 'good' | 'prompt' | 'schema' | 'approval';

export interface SupportOptions {
  variant?: Variant;
  noise?: number;
  degrade?: number;
  degradeSalt?: number;
  verbosity?: number;
  model?: string;
  latencyScale?: number;
  outputScale?: number;
  /** vary behaviour between independent trials (default true) */
  seedBase?: number;
}

const SYSTEM_GOOD = `You are a customer support agent for an online shop. Look up the order before answering any order question. Refunds up to $50 may be issued; larger refunds must be escalated to a human. Cite knowledge-base ids in square brackets when quoting policy. Never reveal other customers' data.`;
const SYSTEM_TERSE = `You are a support agent. TERSE: answer in as few steps as possible and skip lookups when the answer seems obvious.`;

const tools = (variant: Variant) => [
  {
    name: 'lookup_order',
    description: 'Fetch an order by id',
    input_schema: { type: 'object', properties: { [variant === 'schema' ? 'id' : 'order_id']: { type: 'string' } } },
  },
  {
    name: 'create_ticket',
    description: 'Open a support ticket',
    input_schema: { type: 'object', properties: { order_id: { type: 'string' }, issue: { type: 'string' } } },
  },
  {
    name: 'issue_refund',
    description: 'Refund an order (max $50 without approval)',
    input_schema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number' } } },
  },
  { name: 'search_kb', description: 'Search the help centre', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  {
    name: 'escalate_to_human',
    description: 'Hand over to a human',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } } },
  },
];

export function createSupportAgent(opts: SupportOptions = {}) {
  const variant = opts.variant ?? 'good';
  return async function supportAgent(input: Case['input'], tg: AgentContext): Promise<string> {
    const question = typeof input === 'string' ? input : JSON.stringify(input);
    const model = opts.model ?? 'mock-large';
    const llm = wrapAnthropic(tg, () =>
      createMockLLM({
        seed: (opts.seedBase ?? 0) * 1000 + tg.trial,
        noise: opts.noise,
        degrade: opts.degrade,
        degradeSalt: opts.degradeSalt,
        verbosity: opts.verbosity,
        model,
        latencyScale: opts.latencyScale,
        outputScale: opts.outputScale,
      }),
    );
    const db = { tickets: [] as unknown[], refunds: [] as unknown[] };
    const exec: Record<string, (a: Record<string, unknown>) => unknown> = {
      lookup_order: (a) => {
        const o = ORDERS.find((x) => x.order_id === a.order_id);
        if (!o) throw new Error(`order not found: ${JSON.stringify(a)}`);
        return o;
      },
      create_ticket: (a) => {
        const t = { ticket_id: `TCK-${db.tickets.length + 1}`, ...a };
        db.tickets.push(t);
        return t;
      },
      issue_refund: (a) => {
        const r = { refund_id: `RF-${db.refunds.length + 1}`, order_id: a.order_id, amount: a.amount };
        db.refunds.push(r);
        return r;
      },
      search_kb: (a) => searchKb(String(a.query)),
      escalate_to_human: (a) => ({ ok: true, reason: a.reason }),
    };
    const messages: unknown[] = [{ role: 'user', content: question }];
    let last = '';
    for (let step = 0; step < 6; step++) {
      const res = await llm.messages.create({
        model,
        max_tokens: 400,
        temperature: 0,
        system: variant === 'prompt' ? SYSTEM_TERSE : SYSTEM_GOOD,
        tools: tools(variant),
        messages,
      });
      messages.push({ role: 'assistant', content: res.content });
      const uses = res.content.filter((b: { type: string }) => b.type === 'tool_use');
      last = res.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('');
      if (!uses.length) break;
      const results: unknown[] = [];
      for (const u of uses) {
        let content: string;
        try {
          if (u.name === 'issue_refund' && variant !== 'approval') {
            // policy: only refunds up to $50 are auto-approved, and the approval is recorded before the refund
            if (Number(u.input.amount) > 50) throw new Error('refund above $50 needs a human');
            tg.event('approval', { auto: true, amount: u.input.amount });
          }
          const out = await tg.tool(u.name, u.input, (a: Record<string, unknown>) => exec[u.name](a));
          if (u.name === 'escalate_to_human') tg.event('escalation', u.input);
          if (u.name === 'search_kb') {
            await tg.retrieval(
              String(u.input.query),
              () => (out as { id: string; score: number; text: string }[]).map((d) => ({ id: d.id, score: d.score, text: d.text })),
              3,
            );
          }
          content = JSON.stringify(u.name === 'search_kb' ? { results: out } : out);
        } catch (e) {
          content = JSON.stringify({ error: (e as Error).message });
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content });
      }
      messages.push({ role: 'user', content: results });
    }
    if (/sorry, i can't help/i.test(last)) tg.event('refusal');
    tg.setState(db);
    return last;
  };
}
