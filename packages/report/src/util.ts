export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const f = (x: number, d = 3): string => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d)) : 'n/a');
export const pct = (x: number): string => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'n/a');
export const money = (x: number): string => (x < 0.01 ? '$' + x.toFixed(5) : '$' + x.toFixed(3));
export const ci = (c: { estimate: number; lo: number; hi: number }, fmt: (x: number) => string = f): string =>
  `${fmt(c.estimate)} [${fmt(c.lo)}, ${fmt(c.hi)}]`;

export const CSS = `
:root{--bg:#fff;--fg:#1d2330;--mut:#667085;--line:#e4e7ec;--card:#f8f9fb;--bad:#b42318;--good:#067647;--warn:#b54708;--acc:#2e5bff}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--fg:#e6e9ef;--mut:#98a2b3;--line:#2a3140;--card:#1a1f2a;--bad:#f97066;--good:#47cd89;--warn:#fdb022;--acc:#8ca4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.mut{color:var(--mut)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.big{font-size:22px;font-weight:650}
.bad{color:var(--bad)}.good{color:var(--good)}.warn{color:var(--warn)}code,pre{font:12px ui-monospace,monospace}pre{background:var(--card);border:1px solid var(--line);padding:8px;border-radius:6px;overflow:auto;max-height:260px;white-space:pre-wrap}
.pill{display:inline-block;padding:0 8px;border-radius:10px;font-size:12px;border:1px solid var(--line)}details{margin:4px 0}summary{cursor:pointer}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:700px){.cols{grid-template-columns:1fr}}
`;
export const page = (title: string, body: string, script = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
