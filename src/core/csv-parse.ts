/**
 * CSV reader for imports. Follows RFC 4180 (quoted fields, doubled quotes, line breaks inside
 * quotes, CRLF or LF) and is forgiving about what real exports do: a UTF-8 byte order mark, a
 * semicolon or tab instead of a comma, blank lines, and rows with too few cells.
 * The writer is in `core/csv.ts`.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** True when the file had more than `maxRows` data rows and the rest were left out. */
  truncated: boolean;
}

export interface CsvParseOptions {
  /** Most data rows to keep, not counting the header row. Default 50,000. */
  maxRows?: number;
  /** One character. Detected from the first line when not given. */
  delimiter?: string;
}

const DELIMITERS = [',', ';', '\t'];

/** The delimiter that appears most often outside quotes on the first line. A tie goes to the earlier one in `, ; tab`. */
function detectDelimiter(text: string): string {
  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ',';
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

const isEmptyRow = (row: string[]) => row.every((cell) => cell === '');

/** Read CSV text into a header row and data rows. Short rows are padded with empty strings. */
export function parseCsv(text: string, opts: CsvParseOptions = {}): ParsedCsv {
  const maxRows = Math.max(0, opts.maxRows ?? 50_000);
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = opts.delimiter?.[0] ?? detectDelimiter(src);

  const rows: string[][] = [];
  let truncated = false;
  let row: string[] = [];
  let field = '';
  let quotedField = false;
  let inQuotes = false;

  /** Returns false once the row limit is hit and there is nothing more to read. */
  const endRow = (): boolean => {
    row.push(field);
    const blank = row.length === 1 && field === '' && !quotedField;
    const done = row;
    row = [];
    field = '';
    quotedField = false;
    if (blank) return true; // a blank line
    if (rows.length > maxRows) {
      // The header plus `maxRows` rows are already in: only a row with something in it means more data.
      if (isEmptyRow(done)) return true;
      truncated = true;
      return false;
    }
    rows.push(done);
    return true;
  };

  let more = true;
  for (let i = 0; i < src.length && more; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
    } else if (ch === '"' && field === '' && !quotedField) {
      inQuotes = true;
      quotedField = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      quotedField = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      more = endRow();
    } else {
      field += ch;
    }
  }
  if (more && (field !== '' || row.length > 0 || quotedField)) endRow();

  // Spreadsheets pad exports with rows of nothing but delimiters.
  while (rows.length > 0 && isEmptyRow(rows[rows.length - 1]!)) rows.pop();

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  const width = headers.length;
  for (const r of rows) while (r.length < width) r.push('');
  return { headers, rows, truncated };
}

/** Lowercase and keep only letters and digits, so "E-mail address" and "email_address" meet. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * For the column-mapping step of an import: find which column holds each wanted field.
 * `wanted` maps a field name to the header names it may go by, best guess first.
 * Matching ignores case and punctuation, and each column is given to one field at most.
 * A field with no match is `null`, so the person can pick one by hand.
 */
export function guessColumns(headers: string[], wanted: Record<string, string[]>): Record<string, number | null> {
  const normalized = headers.map(normalize);
  const taken = new Set<number>();
  const out: Record<string, number | null> = {};
  for (const [field, aliases] of Object.entries(wanted)) {
    out[field] = null;
    for (const alias of aliases) {
      const target = normalize(alias);
      if (!target) continue;
      const at = normalized.findIndex((h, i) => h === target && !taken.has(i));
      if (at !== -1) {
        out[field] = at;
        taken.add(at);
        break;
      }
    }
  }
  return out;
}

/** Turn rows into objects keyed by header. A repeated header keeps its first column, and a missing cell is an empty string. */
export function rowsToObjects(headers: string[], rows: string[][]): Record<string, string>[] {
  // Column index for each distinct, non-empty header. `fromEntries` is safe for names like "__proto__".
  const columns: [string, number][] = [];
  const seen = new Set<string>();
  headers.forEach((header, i) => {
    if (header === '' || seen.has(header)) return;
    seen.add(header);
    columns.push([header, i]);
  });
  return rows.map((row) => Object.fromEntries(columns.map(([header, i]) => [header, row[i] ?? ''])));
}
