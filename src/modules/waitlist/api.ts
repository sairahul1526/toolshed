/** REST API at /api/v1/waitlist. Reads need `waitlist:read`, changes need `waitlist:write`. */
import { Hono, type Context } from 'hono';
import { auditFromRequest } from '../../core/audit';
import { orgDb, parseJson, type OrgDb } from '../../core/db';
import { errors, parse, readJson } from '../../core/errors';
import { requireScope } from '../../core/guards';
import type { AppEnv } from '../../env';
import { wlErrors } from './errors';
import {
  broadcastAudience,
  cancelBroadcast,
  cancelWave,
  createBroadcast,
  createWave,
  listBroadcasts,
  listWaves,
  sendTest,
  startBroadcast,
  startWave,
} from './launch';
import { baseUrl } from './platform';
import { positionOf } from './queue';
import { bulk, clearTestSignups, erase, removeOne, reviewQueue, type BulkAction } from './review';
import { listSignups, parseSegment, SORTS, type SortKey } from './segments';
import { broadcastJson, signupJson, tierJson, waitlistJson, waveJson } from './serialize';
import { afterJoin, join, trackAcceptance } from './signups';
import { waitlistStats } from './stats';
import { exportCsv, guessMapping, importRows, parseCsv, type ImportMapping } from './transfer';
import { moveTo } from './queue';
import { addTier, createWaitlist, deleteWaitlist, getWaitlist, listTiers, listWaitlists, removeTier, updateWaitlist, waitlistSchema } from './waitlists';
import type { Signup, Waitlist } from './types';

type C = Context<AppEnv>;

const read = requireScope('waitlist:read');
const write = requireScope('waitlist:write');

function scope(c: C): { db: OrgDb; base: string; orgId: string } {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return { db: orgDb(c.env.DB, org.id), base: baseUrl(c), orgId: org.id };
}

async function listFor(c: C): Promise<{ db: OrgDb; base: string; wl: Waitlist }> {
  const { db, base } = scope(c);
  return { db, base, wl: await getWaitlist(db, c.req.param('id') ?? '') };
}

async function person(db: OrgDb, wl: Waitlist, id: string): Promise<Signup> {
  const s = await db.get<Signup>('wl_signups', id);
  if (!s || s.waitlist_id !== wl.id) throw wlErrors.person_not_found();
  return s;
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const api = new Hono<AppEnv>();

// ---- Waitlists ----

api.get('/waitlists', read, async (c) => {
  const { db, base } = scope(c);
  return c.json({ data: (await listWaitlists(db)).map((w) => waitlistJson(w, base)) });
});

api.post('/waitlists', write, async (c) => {
  const { db, base } = scope(c);
  const wl = await createWaitlist(db, parse(waitlistSchema.partial().extend({ name: waitlistSchema.shape.name }), await readJson(c)));
  await auditFromRequest(c, { action: 'waitlist.created', targetType: 'waitlist', targetId: wl.id, summary: `Created waitlist ${wl.name}` });
  return c.json(waitlistJson(wl, base), 201);
});

api.get('/waitlists/:id', read, async (c) => {
  const { wl, base } = await listFor(c);
  return c.json(waitlistJson(wl, base));
});

api.patch('/waitlists/:id', write, async (c) => {
  const { db, base, wl } = await listFor(c);
  const next = await updateWaitlist(db, wl.id, parse(waitlistSchema.partial(), await readJson(c)));
  await auditFromRequest(c, { action: 'waitlist.updated', targetType: 'waitlist', targetId: wl.id, summary: `Changed waitlist ${next.name}` });
  return c.json(waitlistJson(next, base));
});

api.delete('/waitlists/:id', write, async (c) => {
  const { db, wl } = await listFor(c);
  await deleteWaitlist(db, wl.id);
  await auditFromRequest(c, { action: 'waitlist.deleted', targetType: 'waitlist', targetId: wl.id, summary: `Deleted waitlist ${wl.name}` });
  return c.json({ ok: true });
});

api.get('/waitlists/:id/tiers', read, async (c) => {
  const { db, wl } = await listFor(c);
  return c.json({ data: (await listTiers(db, wl.id)).map(tierJson) });
});

api.post('/waitlists/:id/tiers', write, async (c) => {
  const { db, wl } = await listFor(c);
  const body = await readJson(c);
  const tier = await addTier(db, wl.id, { referrals_required: body.referralsRequired, name: body.name, reward_text: body.reward });
  return c.json(tierJson(tier), 201);
});

api.delete('/waitlists/:id/tiers/:tierId', write, async (c) => {
  const { db, wl } = await listFor(c);
  await removeTier(db, wl.id, c.req.param('tierId'));
  return c.json({ ok: true });
});

// ---- People ----

api.get('/waitlists/:id/signups', read, async (c) => {
  const { db, base, wl } = await listFor(c);
  const q = c.req.query();
  const sort = (q.sort && q.sort in SORTS ? q.sort : 'position') as SortKey;
  const page = num(q.page, 1);
  const pageSize = Math.min(num(q.pageSize, 25), 200);
  const segment = parseSegment(q);
  const { rows, total } = await listSignups(db, wl.id, { segment, sort, page, pageSize });
  const ranked = sort === 'position' && segment.status === 'active';
  return c.json({
    data: rows.map((s, i) => signupJson(wl, s, base, ranked ? (page - 1) * pageSize + i + 1 + wl.head_start : null)),
    total,
    page,
    pageSize,
  });
});

api.post('/waitlists/:id/signups', write, async (c) => {
  const { db, base, wl } = await listFor(c);
  const body = await readJson(c);
  const result = await join(c.env, wl, { ...body, email: body.email, trusted: true, verified: body.verified === true, visitor: '', base }, Date.now());
  if (result.kind === 'existing') throw errors.conflict('That email is already on this waitlist.');
  await afterJoin(c.env, result.signup.id, base);
  const fresh = (await db.get<Signup>('wl_signups', result.signup.id)) ?? result.signup;
  return c.json(signupJson(wl, fresh, base, await positionOf(db, wl, fresh)), 201);
});

api.post('/waitlists/:id/signups/bulk', write, async (c) => {
  const { base, wl } = await listFor(c);
  const body = await readJson(c);
  const action = String(body.action ?? '') as BulkAction;
  if (!['approve', 'reject', 'remove', 'tag', 'untag', 'unsubscribe'].includes(action)) throw errors.validation_failed('Unknown action.', { action: 'Use approve, reject, remove, tag, untag or unsubscribe.' });
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length) throw errors.validation_failed('Pick at least one person.', { ids: 'Send a list of signup ids.' });
  const res = await bulk(c.env, wl, action, ids, { tag: typeof body.tag === 'string' ? body.tag : '', base });
  await auditFromRequest(c, { action: `waitlist.signups.${action}`, targetType: 'waitlist', targetId: wl.id, summary: `${action} on ${ids.length} people` });
  return c.json(res);
});

api.get('/waitlists/:id/signups/:sid', read, async (c) => {
  const { db, base, wl } = await listFor(c);
  const s = await person(db, wl, c.req.param('sid'));
  return c.json(signupJson(wl, s, base, await positionOf(db, wl, s)));
});

api.patch('/waitlists/:id/signups/:sid', write, async (c) => {
  const { db, base, wl } = await listFor(c);
  const s = await person(db, wl, c.req.param('sid'));
  const body = await readJson(c);
  const patch: Record<string, string> = {};
  if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 100);
  if (Object.keys(patch).length) await db.update('wl_signups', s.id, patch);
  if (body.position !== undefined) {
    const place = Number(body.position);
    if (!Number.isFinite(place) || place < 1) throw errors.validation_failed(undefined, { position: 'Use a place of 1 or more.' });
    await moveTo(db, wl, s, place);
  }
  const fresh = (await db.get<Signup>('wl_signups', s.id)) ?? s;
  await auditFromRequest(c, { action: 'waitlist.signup.updated', targetType: 'signup', targetId: s.id, summary: `Changed ${s.email}` });
  return c.json(signupJson(wl, fresh, base, await positionOf(db, wl, fresh)));
});

api.delete('/waitlists/:id/signups/:sid', write, async (c) => {
  const { db, wl } = await listFor(c);
  const s = await person(db, wl, c.req.param('sid'));
  if (c.req.query('erase') === '1') await erase(c.env, wl, s);
  else await removeOne(c.env, db, wl, s, Date.now());
  await auditFromRequest(c, { action: c.req.query('erase') === '1' ? 'waitlist.signup.erased' : 'waitlist.signup.removed', targetType: 'signup', targetId: s.id, summary: `${c.req.query('erase') === '1' ? 'Erased' : 'Removed'} ${s.email}` });
  return c.json({ ok: true });
});

/** The invite was used. Call this from your app when a person signs up with their invite code. */
api.post('/waitlists/:id/signups/:sid/accept', write, async (c) => {
  const { db, base, wl } = await listFor(c);
  const s = await person(db, wl, c.req.param('sid'));
  if (!s.invite_code) throw wlErrors.wrong_state('This person has not been invited.');
  const done = await trackAcceptance(c.env, wl, s.invite_code);
  return c.json(signupJson(wl, done ?? s, base));
});

api.get('/waitlists/:id/review', read, async (c) => {
  const { db, base, wl } = await listFor(c);
  return c.json({ data: (await reviewQueue(db, wl.id)).map((s) => signupJson(wl, s, base)) });
});

api.delete('/waitlists/:id/test', write, async (c) => {
  const { db, wl } = await listFor(c);
  return c.json({ removed: await clearTestSignups(db, wl.id) });
});

// ---- Invite waves and broadcasts ----

api.get('/waitlists/:id/waves', read, async (c) => {
  const { db, wl } = await listFor(c);
  return c.json({ data: (await listWaves(db, wl.id)).map(waveJson) });
});

api.post('/waitlists/:id/waves', write, async (c) => {
  const { db, base, wl } = await listFor(c);
  const body = await readJson(c);
  const wave = await createWave(db, wl, { ...body, scheduled_at: typeof body.scheduledAt === 'string' ? Date.parse(body.scheduledAt) || null : null }, parseSegment(body.segment), base);
  if (body.start === true) return c.json(waveJson(await startWave(c.env, db, wave)), 201);
  return c.json(waveJson(wave), 201);
});

api.post('/waitlists/:id/waves/:wid/:action{start|cancel}', write, async (c) => {
  const { db } = await listFor(c);
  const wave = await db.get<import('./types').Wave>('wl_waves', c.req.param('wid'));
  if (!wave || wave.waitlist_id !== c.req.param('id')) throw wlErrors.not_found('That wave does not exist.');
  if (c.req.param('action') === 'start') return c.json(waveJson(await startWave(c.env, db, wave)));
  await cancelWave(db, wave);
  return c.json({ ok: true });
});

api.get('/waitlists/:id/broadcasts', read, async (c) => {
  const { db, wl } = await listFor(c);
  return c.json({ data: (await listBroadcasts(db, wl.id)).map(broadcastJson) });
});

api.post('/waitlists/:id/broadcasts', write, async (c) => {
  const { db, base, wl } = await listFor(c);
  const body = await readJson(c);
  const bc = await createBroadcast(db, wl, body, parseSegment(body.segment), base);
  return c.json({ ...broadcastJson(bc), audience: await broadcastAudience(db, wl, parseSegment(parseJson(bc.segment, {}))) }, 201);
});

api.post('/waitlists/:id/broadcasts/:bid/:action{test|start|cancel}', write, async (c) => {
  const { db, wl } = await listFor(c);
  const bc = await db.get<import('./types').Broadcast>('wl_broadcasts', c.req.param('bid'));
  if (!bc || bc.waitlist_id !== wl.id) throw wlErrors.not_found('That broadcast does not exist.');
  const action = c.req.param('action');
  if (action === 'test') {
    const to = String((await readJson(c)).to ?? '');
    if (!to.includes('@')) throw errors.validation_failed(undefined, { to: 'Enter an email address for the test.' });
    return c.json(broadcastJson(await sendTest(c.env, db, wl, bc, to)));
  }
  if (action === 'start') {
    const started = await startBroadcast(c.env, db, wl, bc);
    await auditFromRequest(c, { action: 'waitlist.broadcast.started', targetType: 'broadcast', targetId: bc.id, summary: `Started broadcast to ${started.total} people` });
    return c.json(broadcastJson(started));
  }
  await cancelBroadcast(db, bc);
  return c.json({ ok: true });
});

// ---- Numbers, export and import ----

api.get('/waitlists/:id/stats', read, async (c) => {
  const { db, wl } = await listFor(c);
  return c.json(await waitlistStats(db, wl, Math.min(num(c.req.query('days'), 30), 365)));
});

api.get('/waitlists/:id/export.csv', read, async (c) => {
  const { db, base, wl } = await listFor(c);
  const csv = await exportCsv(db, wl, base, parseSegment(c.req.query()));
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${wl.slug}-signups.csv"`, 'cache-control': 'no-store' } });
});

api.post('/waitlists/:id/import', write, async (c) => {
  const { wl } = await listFor(c);
  const body = await readJson(c);
  const rows = parseCsv(typeof body.csv === 'string' ? body.csv : '');
  const header = rows.shift() ?? [];
  const mapping = { ...guessMapping(header), ...(body.mapping as Partial<ImportMapping> | undefined) };
  if (mapping.email === undefined) throw wlErrors.bad_import('No email column found. Say which column holds the address.');
  const result = await importRows(c.env, wl, rows, mapping as ImportMapping, { verified: body.verified === true });
  await auditFromRequest(c, { action: 'waitlist.import', targetType: 'waitlist', targetId: wl.id, summary: `Imported ${result.added} people` });
  return c.json(result);
});
