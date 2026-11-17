export interface RedactionRules {
  /** Regex sources applied to every string value. */
  patterns?: string[];
  /** Key names (case-insensitive) or dotted paths whose values are always replaced, e.g. "api_key", "headers.authorization". */
  keys?: string[];
  replacement?: string;
}

export const DEFAULT_REDACTION: RedactionRules = {
  patterns: [
    'sk-[A-Za-z0-9_-]{16,}',
    'sk-ant-[A-Za-z0-9_-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'ghp_[A-Za-z0-9]{30,}',
    'Bearer\\s+[A-Za-z0-9._-]{16,}',
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
  ],
  keys: ['api_key', 'apikey', 'authorization', 'password', 'secret', 'token', 'x-api-key'],
  replacement: '[REDACTED]',
};

/** Returns a redaction function. Applied to every event before it reaches disk. */
export function makeRedactor(rules: RedactionRules = DEFAULT_REDACTION): <T>(value: T) => T {
  const repl = rules.replacement ?? '[REDACTED]';
  const res = (rules.patterns ?? []).map((p) => new RegExp(p, 'g'));
  const keys = new Set((rules.keys ?? []).map((k) => k.toLowerCase()));
  const walk = (v: unknown, path: string[]): unknown => {
    if (typeof v === 'string') return res.reduce((s, re) => s.replace(re, repl), v);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const p = [...path, k].join('.').toLowerCase();
        out[k] = keys.has(k.toLowerCase()) || keys.has(p) ? repl : walk(x, [...path, k]);
      }
      return out;
    }
    return v;
  };
  return <T>(value: T): T => walk(value, []) as T;
}
