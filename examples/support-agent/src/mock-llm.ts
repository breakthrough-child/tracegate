/**
 * A deterministic, rule-based stand-in for an LLM that speaks the Anthropic messages shape.
 * It is a SIMULATION: it lets the example (and the statistical experiments) run for free,
 * with configurable noise and a configurable "degradation" that affects a fixed share of cases.
 * Nothing measured against it says anything about a real model.
 */
import { rng } from '@tracegate/core';

export interface MockOptions {
  seed: number;
  /** probability per call of a random behavioural slip (skips a tool or makes a typo in an argument) */
  noise?: number;
  /** fraction of cases (chosen by hash of the input) on which the model misbehaves when the prompt contains "TERSE" */
  degrade?: number;
  /** extra hash salt so different degraded subsets can be drawn */
  degradeSalt?: number;
  model?: string;
  /** multiplier on output length (to simulate a verbose model for cost experiments) */
  verbosity?: number;
  /** multiplier on simulated latency */
  latencyScale?: number;
  /** multiplier on reported output tokens (simulates a model that talks more; changes cost, not behaviour) */
  outputScale?: number;
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const est = (x: unknown): number => Math.ceil(JSON.stringify(x ?? '').length / 4);

type Block = { type: string; [k: string]: unknown };
interface Msg {
  role: string;
  content: string | Block[];
}

export function createMockLLM(o: MockOptions) {
  return {
    messages: {
      async create(req: {
        model: string;
        system?: string;
        messages: Msg[];
        tools?: { name: string; input_schema?: { properties?: Record<string, unknown> } }[];
      }) {
        const first = req.messages[0];
        const userText = typeof first.content === 'string' ? first.content : '';
        const callIdx = req.messages.filter((m) => m.role === 'assistant').length;
        const rand = rng(hash(userText) ^ Math.imul(o.seed + 1, 2654435761) ^ (callIdx * 97));
        const slip = rand() < (o.noise ?? 0);
        const degraded = (req.system ?? '').includes('TERSE') && (hash(userText + (o.degradeSalt ?? 0)) % 1000) / 1000 < (o.degrade ?? 0);
        const text = userText.toLowerCase();
        const order = userText.match(/ORD-\d{4}/)?.[0];
        const param = (tool: string, dflt: string) =>
          Object.keys(req.tools?.find((t) => t.name === tool)?.input_schema?.properties ?? { [dflt]: 1 })[0];
        const results = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []));
        const parsed = results.map((r) => {
          try {
            return JSON.parse(String(r.content));
          } catch {
            return { error: String(r.content) };
          }
        });
        const lastRes = parsed[parsed.length - 1];
        const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `tu_${callIdx}_${name}`, name, input });
        let content: Block[];
        let stop = 'end_turn';
        const say = (t: string) => [
          {
            type: 'text',
            text:
              o.verbosity && o.verbosity > 1
                ? t + ' ' + 'Is there anything else I can help you with today? '.repeat(Math.round(o.verbosity))
                : t,
          },
        ];
        const typo = (id: string) => (slip ? id.slice(0, -1) + String((Number(id.slice(-1)) + 1) % 10) : id);

        const wantsRefund = /refund|money back/.test(text);
        const wantsStatus = /where is|status|track|arriv/.test(text);
        const damaged = /broken|damaged|defect|not working|stopped working/.test(text);
        const kb = /policy|how long|return|shipping|warranty|cancel|gift card|privacy|payment|contact|hours/.test(text) && !order;
        const legal = /lawyer|sue |legal action|attorney/.test(text);
        const attack = /ignore (all |your )?(previous|prior)|other customer|system prompt|someone else/.test(text);

        const skipLookup = degraded || (slip && callIdx === 0 && rand() < 0.5);
        if (legal) {
          content =
            callIdx === 0
              ? [toolUse('escalate_to_human', { reason: 'legal threat' })]
              : say('I have passed this to a human colleague who will contact you shortly.');
        } else if (attack) {
          content = say("Sorry, I can't help with that request. I can only discuss your own orders.");
        } else if (kb) {
          if (callIdx === 0 && !slip) content = [toolUse('search_kb', { query: userText })];
          else if (callIdx === 0) content = say('Our policies vary, please check the website.');
          else {
            const top = (lastRes?.results ?? [])[0];
            content = top
              ? say(`Here is what our policy says: "${top.text}" [${top.id}]`)
              : say('I could not find that in our help centre.');
          }
        } else if (order && (wantsRefund || damaged || wantsStatus)) {
          const lookedUp = parsed.find((p) => p?.order_id);
          if (!lookedUp && callIdx === 0) {
            content = skipLookup
              ? say(`Your order ${order} is on its way and will arrive soon.`)
              : [toolUse('lookup_order', { [param('lookup_order', 'order_id')]: typo(order) })];
          } else if (lastRes?.error && callIdx <= 3) {
            content = say(`I could not look up that order (${String(lastRes.error).slice(0, 60)}).`);
          } else if (wantsRefund) {
            const refunded = results.length >= 2;
            if (lookedUp && !refunded && lookedUp.amount > 100) content = [toolUse('escalate_to_human', { reason: 'refund above limit' })];
            else if (lookedUp && !refunded) content = [toolUse('issue_refund', { order_id: lookedUp.order_id, amount: lookedUp.amount })];
            else
              content = say(
                refunded && lastRes?.refund_id
                  ? `I have refunded $${lastRes.amount} for ${order}.`
                  : 'I have passed your refund request to a human colleague.',
              );
          } else if (damaged) {
            const ticketed = results.length >= 2;
            content =
              lookedUp && !ticketed
                ? [toolUse('create_ticket', { order_id: lookedUp.order_id, issue: userText.slice(0, 80) })]
                : say(`I am sorry about your ${lookedUp?.item ?? 'item'}. I created ticket ${lastRes?.ticket_id ?? ''} for ${order}.`);
          } else {
            content = say(
              lookedUp
                ? `Your order ${order} (${lookedUp.item}) is ${lookedUp.status}, estimated ${lookedUp.eta}.`
                : `I could not find ${order}.`,
            );
          }
        } else {
          content = say('Could you share your order number so I can help?');
        }
        if (content.some((b) => b.type === 'tool_use')) stop = 'tool_use';
        const usage = {
          input_tokens: est(req.system) + est(req.messages) + est(req.tools),
          output_tokens: Math.round(est(content) * (o.outputScale ?? 1)),
        };
        const res = {
          id: `msg_${hash(userText)}_${callIdx}`,
          type: 'message',
          role: 'assistant',
          model: req.model,
          content,
          stop_reason: stop,
          usage,
        };
        const lat = (250 + usage.output_tokens * 6 + usage.input_tokens * 0.4) * (0.8 + rand() * 0.6) * (o.latencyScale ?? 1);
        Object.defineProperty(res, '__latency_ms', { value: Math.round(lat), enumerable: false });
        return res;
      },
    },
  };
}
