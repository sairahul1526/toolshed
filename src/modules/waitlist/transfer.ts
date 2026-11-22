/** Bringing a list in from another tool (CSV with column mapping) and taking it out again. */
import { newId, orgDb, randomToken, type OrgDb } from '../../core/db';
import { toCsv } from '../../core/csv';
import { parseCsv as readCsv } from '../../core/csv-parse';
import type { Env } from '../../env';
import { wlErrors } from './errors';
import { referralLink } from './emails';
import { canonicalEmail, cleanCode, cleanEmail, newReferralCode } from './rules';
import { chunks } from './review';
import { questionsOf } from './waitlists';
import { parseSegment, segmentWhere } from './segments';
import type { Segment, Signup, Waitlist } from './types';

/** One upload adds at most this many people, so a single request stays inside the free-plan limits. */
export const IMPORT_LIMIT = 2000;

/** Read CSV text into rows, the header row first. Uses the shared reader and stops reading past the import limit. */
export function parseCsv(input: string): string[][] {
  const parsed = readCsv(input, { maxRows: IMPORT_LIMIT + 1 });
  return parsed.headers.length ? [parsed.headers, ...parsed.rows] : [];
}

export interface ImportMapping {
  email: number;
  name?: number;
  code?: number;
  referredBy?: number;
  source?: number;
  tags?: number;
  joined?: number;
  /** Question id to column index. */
  answers?: Record<string, number>;
}

const GUESSES: Record<keyof Omit<ImportMapping, 'answers'>, RegExp> = {
  email: /e-?mail/i,
  name: /^(full[ _-]?)?name$|first[ _-]?name/i,
  code: /(referral|ref)[ _-]?(code|id|key)|^code$|^referral$/i,
  referredBy: /referred[ _-]?by|referrer/i,
  source: /^(utm_)?source$|channel/i,
  tags: /^tags?$|labels?/i,
  joined: /created|joined|signed[ _-]?up|date/i,
};

/** Suggest which column holds what, from the header names. The owner can change every guess. */
export function guessMapping(headers: string[]): Partial<ImportMapping> {
  const out: Partial<ImportMapping> = {};
  for (const key of Object.keys(GUESSES) as (keyof typeof GUESSES)[]) {
    const at = headers.findIndex((h) => GUESSES[key].test(h.trim()));
    if (at >= 0) out[key] = at;
  }
  return out;
}

export interface ImportResult {
  added: number;
  existing: number;
  invalid: number;
  duplicatesInFile: number;
  codesKept: number;
  codesRenewed: number;
  referralsLinked: number;
}

const cell = (row: string[], at: number | undefined) => (at === undefined || at < 0 ? '' : (row[at] ?? '').trim());

function tagList(raw: string): string {
  const set = new Set(['imported']);
  for (const t of raw.split(/[,;|]/)) {
    const clean = t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (clean) set.add(clean.slice(0, 30));
  }
  return `,${[...set].sort().join(',')},`;
}

/** Add people from CSV rows (header row excluded). Existing addresses are left alone. Supplied codes are kept so old links keep working. */
export async function importRows(env: Env, wl: Waitlist, rows: string[][], map: ImportMapping, opts: { verified: boolean }, now = Date.now()): Promise<ImportResult> {
  if (rows.length > IMPORT_LIMIT) throw wlErrors.bad_import(`Import up to ${IMPORT_LIMIT} rows at a time. Split the file and upload it in parts.`);
  const db = orgDb(env.DB, wl.org_id);
  const result: ImportResult = { added: 0, existing: 0, invalid: 0, duplicatesInFile: 0, codesKept: 0, codesRenewed: 0, referralsLinked: 0 };
  const questions = questionsOf(wl);
  const seenEmail = new Set<string>();
  const entries: { email: string; row: string[] }[] = [];
  for (const row of rows) {
    const email = cleanEmail(cell(row, map.email));
    if (!email) result.invalid++;
    else if (seenEmail.has(email)) result.duplicatesInFile++;
    else {
      seenEmail.add(email);
      entries.push({ email, row });
    }
  }
  const taken = await takenEmails(db, wl, entries.map((e) => e.email));
  const fresh = entries.filter((e) => !taken.has(e.email));
  result.existing = entries.length - fresh.length;
  const codes = await takenCodes(db, wl, fresh.map((e) => cleanCode(cell(e.row, map.code))).filter(Boolean));
  const refs: { email: string; code: string }[] = [];
  const stmt = env.DB.prepare(
    `INSERT INTO wl_signups (id, org_id, waitlist_id, email, email_key, name, answers, tags, source, code, token, seq, status, email_verified, confirmed_at, processed_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wl_signups WHERE waitlist_id = ?3), 'active', ?12, ?13, ?14, ?15)`,
  );
  const statements: D1PreparedStatement[] = [];
  for (const { email, row } of fresh) {
    let code = cleanCode(cell(row, map.code));
    if (code && !codes.has(code)) result.codesKept++;
    else {
      if (code) result.codesRenewed++;
      code = newReferralCode();
      while (codes.has(code)) code = newReferralCode();
    }
    codes.add(code);
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const value = cell(row, map.answers?.[q.id]);
      if (value) answers[q.id] = value.slice(0, 1000);
    }
    const joined = Date.parse(cell(row, map.joined));
    const when = Number.isFinite(joined) && joined > 0 && joined <= now ? joined : now;
    const ref = cleanCode(cell(row, map.referredBy));
    if (ref) refs.push({ email, code: ref });
    statements.push(
      stmt.bind(newId('wls', now), wl.org_id, wl.id, email, canonicalEmail(email), cell(row, map.name).slice(0, 100), JSON.stringify(answers), tagList(cell(row, map.tags)), cell(row, map.source).slice(0, 60) || 'import', code, randomToken(18), opts.verified ? 1 : 0, opts.verified ? when : null, now, when),
    );
  }
  for (const part of chunks(statements, 50)) await env.DB.batch(part);
  result.added = statements.length;
  if (refs.length) result.referralsLinked = await linkReferrals(db, wl, refs);
  return result;
}

async function takenEmails(db: OrgDb, wl: Waitlist, emails: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks(emails, 90)) {
    const rows = await db.all<{ email: string }>(`SELECT email FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND email IN (${part.map(() => '?').join(', ')})`, wl.id, ...part);
    for (const r of rows) found.add(r.email);
  }
  return found;
}

async function takenCodes(db: OrgDb, wl: Waitlist, codes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks([...new Set(codes)], 90)) {
    const rows = await db.all<{ code: string }>(`SELECT code FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND code IN (${part.map(() => '?').join(', ')})`, wl.id, ...part);
    for (const r of rows) found.add(r.code);
  }
  return found;
}

/** Point imported people at the referrer named in their row, then recount everyone's referrals. */
async function linkReferrals(db: OrgDb, wl: Waitlist, refs: { email: string; code: string }[]): Promise<number> {
  let linked = 0;
  for (const part of chunks(refs, 40)) {
    for (const r of part) {
      const res = await db.run(
        `UPDATE wl_signups SET referred_by = (SELECT x.id FROM wl_signups x WHERE x.org_id = :org AND x.waitlist_id = ? AND x.code = ?), referral_status = 'credited' WHERE org_id = :org AND waitlist_id = ? AND email = ? AND EXISTS (SELECT 1 FROM wl_signups y WHERE y.org_id = :org AND y.waitlist_id = ? AND y.code = ? AND y.code != wl_signups.code)`,
        wl.id, r.code, wl.id, r.email, wl.id, r.code,
      );
      linked += res.changes;
    }
  }
  await db.run(
    `UPDATE wl_signups SET referral_count = (SELECT COUNT(*) FROM wl_signups r WHERE r.org_id = :org AND r.referred_by = wl_signups.id AND r.referral_status = 'credited'), adj = manual_offset - ? * (SELECT COUNT(*) FROM wl_signups r WHERE r.org_id = :org AND r.referred_by = wl_signups.id AND r.referral_status = 'credited') WHERE org_id = :org AND waitlist_id = ? AND is_test = 0`,
    wl.skip_per_referral, wl.id,
  );
  return linked;
}

const EXPORT_LIMIT = 20_000;

/** Everyone on the list as CSV, best place first. Includes each person's referral link so it can move to another tool. */
export async function exportCsv(db: OrgDb, wl: Waitlist, base: string, segment: Segment = {}): Promise<string> {
  const where = segmentWhere(wl.id, parseSegment(segment), false);
  const questions = questionsOf(wl);
  const out: Record<string, unknown>[] = [];
  let place = wl.head_start;
  for (let offset = 0; offset < EXPORT_LIMIT; offset += 1000) {
    const page = await db.all<Signup & { referrer_code: string | null }>(`SELECT *, (SELECT code FROM wl_signups r WHERE r.id = wl_signups.referred_by) AS referrer_code FROM wl_signups WHERE org_id = :org ${where.sql} ORDER BY score ASC, seq ASC LIMIT 1000 OFFSET ?`, ...where.params, offset);
    for (const s of page) {
      if (s.status === 'active') place++;
      const answers = safeAnswers(s.answers);
      out.push({
        email: s.email,
        name: s.name,
        position: s.status === 'active' ? place : '',
        status: s.status,
        verified: s.email_verified ? 'yes' : 'no',
        referral_code: s.code,
        referral_link: referralLink(base, wl, s),
        referrals: s.referral_count,
        referred_by_code: s.referrer_code ?? '',
        source: s.source,
        medium: s.medium,
        campaign: s.campaign,
        tags: s.tags.split(',').filter(Boolean).join(';'),
        joined_at: new Date(s.created_at).toISOString(),
        invited_at: s.invited_at ? new Date(s.invited_at).toISOString() : '',
        accepted_at: s.accepted_at ? new Date(s.accepted_at).toISOString() : '',
        ...Object.fromEntries(questions.map((q) => [q.label, answers[q.id] ?? ''])),
      });
    }
    if (page.length < 1000) break;
  }
  return toCsv(out, { bom: true, columns: out[0] ? Object.keys(out[0]) : ['email'] });
}

function safeAnswers(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}
