/**
 * Who is voting or posting. Visitors are not Toolshed users, so they live in fb_people.
 *
 * Three ways in, strongest first:
 *   1. An SSO token from the customer's own app, checked with verifyJwt (verified, no email needed).
 *   2. An email code (six digits, ten minutes, five attempts), sent with the core email service.
 *   3. When email is not set up: a guest. Guests can post and vote, but their posts wait for approval.
 *
 * The visitor cookie is HttpOnly and signed. It is only set after someone verifies or posts, never
 * for plain browsing. The embed widget cannot rely on cookies in a third-party frame, so it carries
 * the same signed value in a `vt` token on its own URLs.
 */
import { newId } from '../../core/db';
import { emailStatus, isValidAddress, normaliseAddress, sendEmail } from '../../core/email';
import { verifyJwt } from '../../core/jwt';
import { enforceRateLimit } from '../../core/ratelimit';
import type { Env } from '../../env';
import { renderMail } from './emails';
import { emitFb } from './events';
import { fbErrors } from './errors';
import { readSignedToken, signedToken, visitorId } from './lib';
import type { Ctx } from './portal';
import type { Person, Portal } from './types';
import { normaliseEmail, sha256Hex } from './util';

export const COOKIE_TTL_SEC = 180 * 24 * 3600;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_ATTEMPTS = 5;
const PURPOSE_COOKIE = 'feedback-visitor';
const PURPOSE_EMBED = 'feedback-embed';

export function cookieName(portal: Portal): string {
  return `fbv_${portal.slug.replace(/-/g, '_')}`;
}

export async function visitorToken(env: Env, portal: Portal, personId: string): Promise<string> {
  return signedToken(env, PURPOSE_COOKIE, { p: personId, o: portal.org_id }, COOKIE_TTL_SEC);
}

export async function embedToken(env: Env, portal: Portal, personId: string): Promise<string> {
  return signedToken(env, PURPOSE_EMBED, { p: personId, o: portal.org_id }, 24 * 3600);
}

export function setVisitorCookie(headers: Headers, portal: Portal, token: string, secure: boolean): void {
  const parts = [`${cookieName(portal)}=${token}`, 'Path=/', `Max-Age=${COOKIE_TTL_SEC}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  headers.append('set-cookie', parts.join('; '));
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

export function getPerson(ctx: Ctx, id: string): Promise<Person | null> {
  return ctx.db.get<Person>('fb_people', id);
}

/** Person from a signed token (cookie or embed). Null when the token is bad, expired or from another workspace. */
async function personFromToken(ctx: Ctx, purpose: string, token: string | null | undefined): Promise<Person | null> {
  if (!token) return null;
  const body = await readSignedToken<{ p?: string; o?: string }>(ctx.env, purpose, token);
  if (!body || body.o !== ctx.orgId || !body.p) return null;
  return getPerson(ctx, body.p);
}

export interface IdentityInput {
  /** The customer's SSO token, from `sso` in the query or the widget. */
  sso?: string | null;
  /** The embed `vt` token. */
  vt?: string | null;
  cookie?: string | null;
}

/**
 * Work out who is asking. Never creates a cookie. SSO people are created or refreshed on the spot;
 * everyone else must already exist.
 */
export async function resolveIdentity(ctx: Ctx, input: IdentityInput): Promise<Person | null> {
  if (input.sso) {
    const claims = await verifyJwt(ctx.env, input.sso);
    if (claims && claims.orgId === ctx.orgId && claims.exp * 1000 > Date.now() - 1000) {
      return upsertSsoPerson(ctx, claims.sub);
    }
  }
  const viaEmbed = await personFromToken(ctx, PURPOSE_EMBED, input.vt);
  if (viaEmbed) return viaEmbed;
  return personFromToken(ctx, PURPOSE_COOKIE, input.cookie);
}

async function upsertSsoPerson(ctx: Ctx, externalId: string): Promise<Person> {
  const existing = await ctx.db.findOne<Person>('fb_people', { external_id: externalId });
  const now = Date.now();
  if (existing) {
    if (existing.last_seen_at < now - 60_000) await ctx.db.update('fb_people', existing.id, { last_seen_at: now });
    return existing;
  }
  return ctx.db.insert<Person>('fb_people', {
    id: newId('fbu', now),
    email: null,
    name: '',
    source: 'sso',
    external_id: externalId,
    verified: 1,
    trusted: 0,
    blocked: 0,
    mail_off: 0,
    sample: 0,
    created_at: now,
    last_seen_at: now,
  });
}

/** Make or find a verified person for an email address. */
export async function upsertEmailPerson(ctx: Ctx, email: string, opts: { name?: string; source?: Person['source']; verified?: boolean } = {}): Promise<Person> {
  const clean = normaliseEmail(email);
  const existing = await ctx.db.findOne<Person>('fb_people', { email: clean });
  const now = Date.now();
  if (existing) {
    const patch: Record<string, string | number> = { last_seen_at: now };
    if (opts.verified && !existing.verified) patch.verified = 1;
    if (opts.name && !existing.name) patch.name = opts.name;
    return (await ctx.db.update<Person>('fb_people', existing.id, patch)) ?? existing;
  }
  return ctx.db.insert<Person>('fb_people', {
    id: newId('fbu', now),
    email: clean,
    name: opts.name ?? '',
    source: opts.source ?? 'email',
    external_id: null,
    visitor_id: null,
    verified: opts.verified ? 1 : 0,
    trusted: 0,
    blocked: 0,
    mail_off: 0,
    sample: 0,
    created_at: now,
    last_seen_at: now,
  });
}

/** An unverified guest, tied to a day-salted visitor id so rate limits still work. */
export async function createGuest(ctx: Ctx, req: Request, name: string): Promise<Person> {
  const now = Date.now();
  return ctx.db.insert<Person>('fb_people', {
    id: newId('fbu', now),
    email: null,
    name: name.trim().slice(0, 60),
    source: 'guest',
    external_id: null,
    visitor_id: await visitorId(ctx.env, `feedback:${ctx.orgId}`, req, now),
    verified: 0,
    trusted: 0,
    blocked: 0,
    mail_off: 0,
    sample: 0,
    created_at: now,
    last_seen_at: now,
  });
}

export async function setName(ctx: Ctx, person: Person, name: string): Promise<Person> {
  const clean = name.trim().slice(0, 60);
  if (clean === person.name) return person;
  return (await ctx.db.update<Person>('fb_people', person.id, { name: clean })) ?? person;
}

// ---------------------------------------------------------------------------------------------
// Email codes
// ---------------------------------------------------------------------------------------------

function sixDigits(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, '0');
}

async function hashCode(env: Env, orgId: string, email: string, code: string): Promise<string> {
  return sha256Hex(`${env.AUTH_SECRET}|code|${orgId}|${email}|${code}`);
}

/** Can this workspace send sign-in codes right now? When not, the portal falls back to guests. */
export async function codesAvailable(env: Env): Promise<boolean> {
  const status = await emailStatus(env);
  return status.status === 'ready';
}

export interface CodeRequest {
  sent: boolean;
  /** True when email is off, so the caller should offer the guest path instead. */
  guestOnly: boolean;
}

export async function requestCode(ctx: Ctx, portal: Portal, emailInput: string, ip: string): Promise<CodeRequest> {
  const email = normaliseEmail(emailInput);
  if (!isValidAddress(normaliseAddress(email))) throw fbErrors.email_invalid();
  if (!(await codesAvailable(ctx.env))) return { sent: false, guestOnly: true };
  await enforceRateLimit(ctx.env, `feedback.code:email:${ctx.orgId}:${email}`, { limit: 3, windowSec: 3600 }, 'We already sent a few codes to that address. Check your inbox, or try again in an hour.');
  await enforceRateLimit(ctx.env, `feedback.code:ip:${ip}`, { limit: 20, windowSec: 3600 });
  const person = await ctx.db.findOne<Person>('fb_people', { email });
  if (person?.blocked) throw fbErrors.blocked();
  const code = sixDigits();
  const now = Date.now();
  await ctx.db.insert('fb_codes', {
    id: newId('fbk', now),
    email,
    code_hash: await hashCode(ctx.env, ctx.orgId, email, code),
    attempts: 0,
    used_at: null,
    expires_at: now + CODE_TTL_MS,
    created_at: now,
  });
  const mail = await renderMail(ctx.env, ctx.orgId, {
    subject: `Your ${portal.name} code`,
    preheader: `Your code is ${code}`,
    heading: 'Your sign-in code',
    paragraphs: [`Enter this code on the ${portal.name} feedback page. It works for ${Math.round(CODE_TTL_MS / 60000)} minutes.`],
    code,
    small: ['If you did not ask for this, you can ignore the message. Nobody can use the code without access to this inbox.'],
  });
  await sendEmail(ctx.env, { orgId: ctx.orgId, to: email, subject: mail.subject, html: mail.html, text: mail.text, template: 'feedback-code', tag: 'feedback' });
  return { sent: true, guestOnly: false };
}

/** Check a code. Returns the verified person, or throws a plain error. */
export async function verifyCode(ctx: Ctx, emailInput: string, codeInput: string, name = ''): Promise<Person> {
  const email = normaliseEmail(emailInput);
  const code = codeInput.replace(/\D/g, '');
  const now = Date.now();
  const row = await ctx.db.first<{ id: string; code_hash: string; attempts: number; expires_at: number; used_at: number | null }>(
    'SELECT id, code_hash, attempts, expires_at, used_at FROM fb_codes WHERE org_id = :org AND email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
    email,
  );
  if (!row) throw fbErrors.code_invalid();
  if (row.expires_at < now) throw fbErrors.code_expired();
  if (row.attempts >= CODE_ATTEMPTS) throw fbErrors.code_attempts();
  await ctx.db.run('UPDATE fb_codes SET attempts = attempts + 1 WHERE org_id = :org AND id = ?', row.id);
  if (code.length !== 6 || (await hashCode(ctx.env, ctx.orgId, email, code)) !== row.code_hash) {
    if (row.attempts + 1 >= CODE_ATTEMPTS) throw fbErrors.code_attempts();
    throw fbErrors.code_invalid();
  }
  await ctx.db.run('UPDATE fb_codes SET used_at = ? WHERE org_id = :org AND id = ?', now, row.id);
  const before = await ctx.db.findOne<Person>('fb_people', { email });
  const person = await upsertEmailPerson(ctx, email, { name, verified: true });
  if (person.blocked) throw fbErrors.blocked();
  if (!before?.verified) await emitFb(ctx.env, ctx.orgId, 'person.verified', person.id, { source: 'email' });
  return person;
}

/** Fold a guest's posts and votes into a person who just verified. */
export async function adoptGuest(ctx: Ctx, guest: Person, person: Person): Promise<void> {
  if (guest.id === person.id || guest.source !== 'guest') return;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE fb_posts SET author_id = ?3 WHERE org_id = ?1 AND author_id = ?2').bind(ctx.orgId, guest.id, person.id),
    ctx.env.DB.prepare('UPDATE fb_comments SET author_id = ?3 WHERE org_id = ?1 AND author_id = ?2').bind(ctx.orgId, guest.id, person.id),
    ctx.env.DB.prepare('UPDATE OR IGNORE fb_votes SET person_id = ?3 WHERE org_id = ?1 AND person_id = ?2').bind(ctx.orgId, guest.id, person.id),
    ctx.env.DB.prepare('DELETE FROM fb_votes WHERE org_id = ?1 AND person_id = ?2').bind(ctx.orgId, guest.id),
    ctx.env.DB.prepare('DELETE FROM fb_people WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, guest.id),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Admin: block, trust, list
// ---------------------------------------------------------------------------------------------

export async function setBlocked(ctx: Ctx, id: string, blocked: boolean): Promise<Person> {
  const row = await ctx.db.update<Person>('fb_people', id, { blocked: blocked ? 1 : 0 });
  if (!row) throw fbErrors.person_missing();
  return row;
}

export async function setTrusted(ctx: Ctx, id: string, trusted: boolean): Promise<Person> {
  const row = await ctx.db.update<Person>('fb_people', id, { trusted: trusted ? 1 : 0 });
  if (!row) throw fbErrors.person_missing();
  return row;
}

export async function listPeople(ctx: Ctx, opts: { q?: string; filter?: 'blocked' | 'trusted' | 'guest'; limit?: number; offset?: number } = {}): Promise<Person[]> {
  const where: string[] = ['org_id = :org'];
  const params: (string | number)[] = [];
  if (opts.filter === 'blocked') where.push('blocked = 1');
  if (opts.filter === 'trusted') where.push('trusted = 1');
  if (opts.filter === 'guest') where.push("source = 'guest'");
  if (opts.q) {
    where.push("(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
    const like = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }
  params.push(Math.min(opts.limit ?? 50, 200), opts.offset ?? 0);
  return ctx.db.all<Person>(`SELECT * FROM fb_people WHERE ${where.join(' AND ')} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`, ...params);
}

/** Opt a person out of every close-the-loop email. Used by the unsubscribe link. */
export async function mailOff(ctx: Ctx, id: string, off = true): Promise<void> {
  await ctx.db.run('UPDATE fb_people SET mail_off = ? WHERE org_id = :org AND id = ?', off ? 1 : 0, id);
}

export async function unsubscribeToken(env: Env, orgId: string, personId: string): Promise<string> {
  return signedToken(env, 'feedback-unsub', { o: orgId, p: personId }, 3650 * 24 * 3600);
}

export async function readUnsubscribeToken(env: Env, token: string): Promise<{ o: string; p: string } | null> {
  return readSignedToken<{ o: string; p: string }>(env, 'feedback-unsub', token);
}
