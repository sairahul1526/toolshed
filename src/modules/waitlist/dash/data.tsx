/** Moving data: export, import with column mapping, and erasing one person who asks. */
import { Hono } from 'hono';
import { errors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, CodeBlock, Field, Input, LinkButton, PageHeader, Select, Table, Textarea, setFlash } from '../../../ui';
import { formatNumber } from '../../../ui/format';
import { eraseByEmail, reviewCount } from '../review';
import { guessMapping, importRows, IMPORT_LIMIT, parseCsv, type ImportMapping } from '../transfer';
import { questionsOf } from '../waitlists';
import type { Waitlist } from '../types';
import { audit, attempt, EmailNotice, formOf, ListNav, pickList, ROOT, scopeOf, str, to, write, type C, renderPage, Toggle } from './common';

export const data = new Hono<AppEnv>();

const MAX_BYTES = 1_500_000;

function dataPage(c: C, wl: Waitlist, lists: Waitlist[], held: number, body: unknown, title = 'Import and export') {
  return renderPage(c, { title: `${wl.name} ${title.toLowerCase()}`, crumbs: [{ label: 'Waitlist', href: ROOT }, { label: wl.name }] }, (
    <>
      <PageHeader title={wl.name} description="Bring people in from another tool, take your list out, or erase someone who asks." />
      {ListNav({ lists, wl, active: 'data', counts: { review: held } })}
      {body as never}
    </>
  ));
}

data.get('/data', async (c) => {
  const { db, base } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const held = await reviewCount(db, wl.id);
  return dataPage(c, wl, lists, held, (
    <>
      {await EmailNotice({ c })}
      <Card title="Export" description="Everyone on this waitlist as a CSV file, with their referral code and link.">
        <LinkButton href={`/api/v1/waitlist/waitlists/${wl.id}/export.csv`} icon="download">Download CSV</LinkButton>
      </Card>
      <Card title="Import" description={`Up to ${formatNumber(IMPORT_LIMIT)} rows at a time. Existing addresses are skipped. If your file has referral codes, the old links keep working.`}>
        <form method="post" action={to('data/import', wl)} enctype="multipart/form-data" class="wl-form-stack">
          <Field id="imp-file" label="CSV file" hint="Choose a file, or paste the rows below."><input id="imp-file" class="input" type="file" name="file" accept=".csv,text/csv" /></Field>
          <Field id="imp-text" label="Or paste CSV" optional><Textarea id="imp-text" name="csv" rows={4} placeholder={'email,name\nsam@example.com,Sam'} /></Field>
          <div class="wl-actions"><Button type="submit" variant="primary">Read the file</Button></div>
        </form>
      </Card>
      <Card title="Erase a person" description="Deletes their email, name and answers. The waitlist keeps an anonymous count, and the people they referred keep their place.">
        <form method="post" action={to('data/erase', wl)} class="wl-inline">
          <Field id="erase-email" label="Their email address"><Input id="erase-email" name="email" type="email" required /></Field>
          <Button type="submit" variant="danger">Erase</Button>
        </form>
      </Card>
      <Card title="API and events" description="Everything on this screen is also in the REST API. Events are recorded for each signup action.">
        <CodeBlock label="curl example" code={`curl ${base}/api/v1/waitlist/waitlists/${wl.id}/signups \\\n  -H "authorization: Bearer YOUR_API_KEY"`} />
      </Card>
    </>
  ));
});

const FIELDS: { key: keyof ImportMapping; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'name', label: 'Name' },
  { key: 'code', label: 'Referral code' },
  { key: 'referredBy', label: 'Referred by (code)' },
  { key: 'source', label: 'Source' },
  { key: 'tags', label: 'Tags' },
  { key: 'joined', label: 'Joined date' },
];

data.post('/data/import', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const f = await formOf(c);
  const back = to('data', wl);
  let text = str(f.csv);
  if (f.file instanceof File && f.file.size) {
    if (f.file.size > MAX_BYTES) {
      setFlash(c, { kind: 'error', message: 'That file is too large. Split it into parts of up to 2,000 rows.' });
      return c.redirect(back, 303);
    }
    text = await f.file.text();
  }
  const rows = parseCsv(text);
  const header = rows.shift() ?? [];
  if (!header.length || !rows.length) {
    setFlash(c, { kind: 'error', message: 'No rows found. The first row must be the column names.' });
    return c.redirect(back, 303);
  }
  if (rows.length > IMPORT_LIMIT) {
    setFlash(c, { kind: 'error', message: `That file has more than ${formatNumber(IMPORT_LIMIT)} rows. Split it and import it in parts.` });
    return c.redirect(back, 303);
  }
  if (f.confirm !== 'yes') {
    const guess = guessMapping(header);
    const held = await reviewCount(db, wl.id);
    const options = [{ value: '', label: 'Not in the file' }, ...header.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))];
    const questions = questionsOf(wl);
    return dataPage(c, wl, lists, held, (
      <Card title="Match your columns" description={`${formatNumber(rows.length)} rows found. Check which column holds what.`}>
        <form method="post" action={to('data/import', wl)} class="wl-form-stack">
          <input type="hidden" name="confirm" value="yes" />
          <Textarea id="imp-keep" name="csv" value={text} hidden rows={1} aria-hidden="true" tabindex={-1} />
          {FIELDS.map((fl) => (
            <Field id={`m-${fl.key}`} label={fl.label} optional={fl.key !== 'email'}>
              <Select id={`m-${fl.key}`} name={`m_${fl.key}`} value={guess[fl.key] === undefined ? '' : String(guess[fl.key])} options={options} />
            </Field>
          ))}
          {questions.map((q) => (
            <Field id={`m-${q.id}`} label={`Answer: ${q.label}`} optional>
              <Select id={`m-${q.id}`} name={`m_a_${q.id}`} value="" options={options} />
            </Field>
          ))}
          <Toggle name="verified" label="These addresses are already confirmed" />
          <Table caption="First rows of the file" columns={header.slice(0, 4).map((h, i) => ({ key: String(i), label: h || `Column ${i + 1}` }))} rows={rows.slice(0, 3).map((r) => Object.fromEntries(r.slice(0, 4).map((v, i) => [String(i), v])))} />
          <div class="wl-actions"><Button type="submit" variant="primary">Import {formatNumber(rows.length)} rows</Button><LinkButton href={back}>Cancel</LinkButton></div>
        </form>
      </Card>
    ), 'Import');
  }
  const idx = (k: string) => (str(f[`m_${k}`]) === '' ? undefined : Number(str(f[`m_${k}`])));
  const answers: Record<string, number> = {};
  for (const q of questionsOf(wl)) {
    const at = idx(`a_${q.id}`);
    if (at !== undefined) answers[q.id] = at;
  }
  return attempt(c, back, null, async () => {
    const email = idx('email');
    if (email === undefined || Number.isNaN(email)) throw errors.validation_failed('Choose the column that holds the email address.');
    const map: ImportMapping = { email, name: idx('name'), code: idx('code'), referredBy: idx('referredBy'), source: idx('source'), tags: idx('tags'), joined: idx('joined'), answers };
    const res = await importRows(c.env, wl, rows, map, { verified: f.verified === 'on' });
    await audit(c, 'waitlist.import', wl, `Imported ${res.added} people`);
    const kept = res.codesKept ? ` ${formatNumber(res.codesKept)} referral links kept.` : '';
    setFlash(c, { kind: 'ok', message: `Added ${formatNumber(res.added)}, skipped ${formatNumber(res.existing)} already on the list and ${formatNumber(res.invalid)} invalid.${kept}` });
  });
});

data.post('/data/erase', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const email = str((await formOf(c)).email);
  return attempt(c, to('data', wl), null, async () => {
    const found = await eraseByEmail(c.env, wl, email);
    if (found) await audit(c, 'waitlist.signup.erased', wl, 'Erased one person by email');
    setFlash(c, found ? { kind: 'ok', message: 'Erased. The waitlist keeps an anonymous count.' } : { kind: 'info', message: 'No one with that address is on this waitlist.' });
  });
});
