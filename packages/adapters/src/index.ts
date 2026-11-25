import type { AgentContext, Judge } from '@tracegate/core';

type Lazy<T> = T | (() => T);
const resolve = <T>(x: Lazy<T>): (() => T) => {
  let v: T | undefined;
  return () => (v ??= typeof x === 'function' ? (x as () => T)() : x);
};

/**
 * Wrap an Anthropic SDK client (or a factory for one). In replay mode the factory is never called,
 * so no API key or network is needed. Streaming is not supported yet.
 */
export function wrapAnthropic(tg: AgentContext, source: Lazy<any>, opts: { retries?: number } = {}): any {
  const live = resolve(source);
  return {
    messages: {
      create: (req: any) => {
        if (req?.stream) throw new Error('Tracegate: streaming requests are not supported yet; use non-streaming calls when recording');
        return tg.model(
          {
            provider: 'anthropic',
            model: req.model,
            request: req,
            retries: opts.retries,
            params: { temperature: req.temperature, max_tokens: req.max_tokens },
            usage: (r: any) =>
              r?.usage
                ? {
                    input_tokens: r.usage.input_tokens ?? 0,
                    output_tokens: r.usage.output_tokens ?? 0,
                    cache_read_tokens: r.usage.cache_read_input_tokens,
                  }
                : undefined,
          },
          () => live().messages.create(req),
        );
      },
    },
  };
}

/** Wrap an OpenAI or OpenAI-compatible client (chat.completions.create). */
export function wrapOpenAI(tg: AgentContext, source: Lazy<any>, opts: { provider?: string; retries?: number } = {}): any {
  const live = resolve(source);
  return {
    chat: {
      completions: {
        create: (req: any) => {
          if (req?.stream) throw new Error('Tracegate: streaming requests are not supported yet; use non-streaming calls when recording');
          return tg.model(
            {
              provider: opts.provider ?? 'openai',
              model: req.model,
              request: req,
              retries: opts.retries,
              params: { temperature: req.temperature, max_tokens: req.max_tokens },
              usage: (r: any) =>
                r?.usage ? { input_tokens: r.usage.prompt_tokens ?? 0, output_tokens: r.usage.completion_tokens ?? 0 } : undefined,
            },
            () => live().chat.completions.create(req),
          );
        },
      },
    },
  };
}

/** Generic wrapper for any async model function: (request) => response. */
export function wrapModel<Req, Res>(
  tg: AgentContext,
  info: { provider: string; model: string; usage?: (r: Res) => { input_tokens: number; output_tokens: number } | undefined },
  fn: (req: Req) => Promise<Res>,
): (req: Req) => Promise<Res> {
  return (req) => tg.model({ provider: info.provider, model: info.model, request: req, usage: info.usage }, () => fn(req));
}

/** Wrap a map of tool functions so every call is recorded (also in replay). */
export function wrapTools<T extends Record<string, (args: any) => any>>(tg: AgentContext, tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(tools)) out[name] = (args: unknown) => tg.tool(name, args, fn);
  return out as T;
}

/** Wrap a Model Context Protocol client: every callTool is recorded as a tool call. */
export function wrapMcpClient<
  C extends { callTool: (p: { name: string; arguments?: Record<string, unknown> }, ...rest: any[]) => Promise<any> },
>(tg: AgentContext, client: C): C {
  return new Proxy(client, {
    get(target, prop, recv) {
      if (prop === 'callTool') {
        return (params: { name: string; arguments?: Record<string, unknown> }, ...rest: any[]) =>
          tg.tool(params.name, params.arguments ?? {}, async () => {
            const r = await target.callTool(params, ...rest);
            if (r?.isError) throw new Error(typeof r.content?.[0]?.text === 'string' ? r.content[0].text : 'MCP tool error');
            return r;
          });
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

/* ---------- judges over HTTP (no SDK needed) ---------- */

export interface JudgeOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Anthropic: sent only when set, because current Claude models reject a non-default temperature. */
  temperature?: number;
  /** Anthropic `output_config.effort`; sent only when set. */
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  /** Called with the token usage of each successful call. */
  onUsage?: (u: { input_tokens: number; output_tokens: number }) => void;
}

export function anthropicJudge(o: JudgeOptions): Judge {
  return {
    model: o.model,
    temperature: o.temperature,
    async complete(system, user) {
      const key = o.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('ANTHROPIC_API_KEY is not set (needed for the Anthropic judge)');
      const res = await fetch((o.baseUrl ?? 'https://api.anthropic.com') + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: o.model,
          max_tokens: o.maxTokens ?? 2000,
          temperature: o.temperature,
          output_config: o.effort ? { effort: o.effort } : undefined,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic judge error ${res.status}: ${await res.text()}`);
      const j = (await res.json()) as {
        content: { type: string; text?: string }[];
        usage?: { input_tokens: number; output_tokens: number };
      };
      if (j.usage) o.onUsage?.(j.usage);
      return j.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
    },
  };
}

export function openaiJudge(o: JudgeOptions): Judge {
  const temperature = o.temperature ?? 0;
  return {
    model: o.model,
    temperature,
    async complete(system, user) {
      const key = o.apiKey ?? process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY is not set (needed for the OpenAI-compatible judge)');
      const res = await fetch((o.baseUrl ?? 'https://api.openai.com/v1') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: o.model,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI judge error ${res.status}: ${await res.text()}`);
      const j = (await res.json()) as { choices: { message: { content: string } }[] };
      return j.choices[0]?.message?.content ?? '';
    },
  };
}

/**
 * A fake judge for testing pipelines without an API key: a deterministic coin flip on the prompt text (pass rate `p`).
 * Its verdicts mean nothing. Any report made with it must be labelled simulated.
 */
export function simulatedJudge(p = 0.5): Judge {
  return {
    model: `simulated(p=${p})`,
    async complete(_system, user) {
      let h = 2166136261;
      for (let i = 0; i < user.length; i++) h = Math.imul(h ^ user.charCodeAt(i), 16777619);
      const verdict = ((h >>> 0) % 1000) / 1000 < p ? 'pass' : 'fail';
      return JSON.stringify({ verdict, reasoning: 'simulated judge: verdict has no meaning' });
    },
  };
}

/** Pick a judge from environment variables, or undefined when none is configured. */
export function judgeFromEnv(spec?: string): Judge | undefined {
  const [provider, model] = (spec ?? '').split(':');
  if (provider === 'simulated') return simulatedJudge(model ? Number(model) : undefined);
  if (provider === 'anthropic' || (!spec && process.env.ANTHROPIC_API_KEY)) return anthropicJudge({ model: model || 'claude-sonnet-4-5' });
  if (provider === 'openai' || (!spec && process.env.OPENAI_API_KEY))
    return openaiJudge({ model: model || 'gpt-4o-mini', baseUrl: process.env.OPENAI_BASE_URL });
  return undefined;
}
