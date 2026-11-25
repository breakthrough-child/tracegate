/** Minimal RFC 4180 CSV: quoted fields, escaped quotes, newlines inside quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** Parse CSV with a header row into objects keyed by column name. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

export function toCsv(columns: string[], rows: Record<string, string>[]): string {
  const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))].map((r) => r.map(q).join(',')).join('\n') + '\n';
}
