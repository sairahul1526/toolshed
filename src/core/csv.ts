/**
 * CSV writer. Follows RFC 4180 (CRLF line ends, quote a cell that holds a comma, quote or line break,
 * double inner quotes) and guards against spreadsheet formula injection: a text cell that starts
 * with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe, so Excel and Sheets show
 * it as text instead of running it.
 */

const BOM = '\uFEFF';
const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA = /^[=+\-@\t\r]/;

export interface CsvOptions {
  /** Add a UTF-8 byte order mark so Excel opens non-Latin text correctly. */
  bom?: boolean;
  /** Turn the formula guard off, for data that is not meant to be opened in a spreadsheet. Defaults to on. */
  guard?: boolean;
}

/** One cell as text. Numbers and booleans are written as they are; objects as JSON. */
export function csvCell(value: unknown, opts: CsvOptions = {}): string {
  if (value === null || value === undefined) return '';
  let text: string;
  let isText = false;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') text = String(value);
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') {
    text = JSON.stringify(value);
    isText = true;
  } else {
    text = String(value);
    isText = true;
  }
  if (isText && opts.guard !== false && FORMULA.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line, including the closing CRLF. */
export function csvRow(cells: readonly unknown[], opts: CsvOptions = {}): string {
  return `${cells.map((c) => csvCell(c, opts)).join(',')}\r\n`;
}

/** A whole table. `rows` are objects; `columns` fixes the order (default: keys of the first row). */
export function toCsv(rows: readonly Record<string, unknown>[], opts: CsvOptions & { columns?: readonly string[] } = {}): string {
  const columns = opts.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  let out = opts.bom ? BOM : '';
  if (columns.length === 0) return out;
  // Header names are ours, not user data, but guard them too: a column called "-x" must not run.
  out += csvRow(columns, opts);
  for (const row of rows) out += csvRow(columns.map((c) => row[c]), opts);
  return out;
}
