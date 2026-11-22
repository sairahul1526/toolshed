/** Launch: let people in with invite waves, and write to a group with a broadcast that is tested first. */
import { Hono } from 'hono';
import { errors } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, ConfirmButton, EmptyState, Field, Input, PageHeader, Pill, Select, Table, Textarea, setFlash } from '../../../ui';
import { formatDateTime, formatNumber } from '../../../ui/format';
import { parseJson } from '../../../core/db';
import { broadcastAudience, cancelBroadcast, cancelWave, createBroadcast, createWave, listBroadcasts, listWaves, sendTest, startBroadcast, startWave, wavePreview } from '../launch';
import { parseSegment, segmentSummary } from '../segments';
import { canSendEmail } from '../emails';
import { reviewCount } from '../review';
import { wlErrors } from '../errors';
import type { Broadcast, Wave } from '../types';
import { audit, attempt, EmailNotice, formOf, ListNav, pickList, ROOT, scopeOf, str, to, write, renderPage } from './common';

export const launch = new Hono<AppEnv>();

const TONE = { draft: 'neutral', scheduled: 'warn', sending: 'warn', done: 'good', cancelled: 'neutral' } as const;
const WAVE_BODY = 'Hi {{name}},\n\nYou are next. Your invite is ready.\n\nUse the button below to claim it.';

function SegmentFields({ prefix }: { prefix: string }) {
  return (
    <div class="wl-segment">
      <Field id={`${prefix}-tag`} label="Only people tagged" optional><Input id={`${prefix}-tag`} name="tag" maxlength={30} placeholder="beta" /></Field>
      <Field id={`${prefix}-min`} label="At least this many referrals" optional><Input id={`${prefix}-min`} name="minReferrals" type="number" min={0} placeholder="0" /></Field>
      <Field id={`${prefix}-source`} label="Only from source" optional><Input id={`${prefix}-source`} name="source" maxlength={60} placeholder="newsletter" /></Field>
      <Field id={`${prefix}-verified`} label="Email confirmed" optional>
        <Select id={`${prefix}-verified`} name="verified" options={[{ value: '', label: 'Either' }, { value: 'yes', label: 'Confirmed only' }, { value: 'no', label: 'Unconfirmed only' }]} />
      </Field>
    </div>
  );
}

const segmentOf = (f: Record<string, unknown>) => parseSegment({ tag: f.tag, minReferrals: f.minReferrals, source: f.source, verified: f.verified });

function WaveRow({ w, wlId }: { w: Wave; wlId: string }) {
  const open = w.status === 'draft' || w.status === 'scheduled';
  return {
    name: <><strong>{w.name}</strong><br /><span class="wl-note">{segmentSummary(parseSegment(parseJson(w.segment, {})))}</span></>,
    status: <Pill tone={TONE[w.status]}>{w.status}</Pill>,
    size: formatNumber(w.size),
    sent: `${formatNumber(w.sent)} emailed, ${formatNumber(w.accepted)} accepted`,
    act: (
      <form method="post" action={`${ROOT}/launch/wave/${w.id}/${open ? 'start' : 'cancel'}?w=${wlId}`}>
        {open ? <Button type="submit" size="sm" variant="primary">Start now</Button> : w.status === 'sending' ? <Button type="submit" size="sm">Cancel</Button> : null}
      </form>
    ),
  };
}

function BroadcastCard({ b, wlId, canSend }: { b: Broadcast; wlId: string; canSend: boolean }) {
  const draft = b.status === 'draft';
  const tested = Boolean(b.test_hash);
  return (
    <Card title={b.subject} description={<><Pill tone={TONE[b.status]}>{b.status}</Pill> {segmentSummary(parseSegment(parseJson(b.segment, {})))}, {formatNumber(b.total)} people</>}>
      {draft ? (
        <div class="wl-bc">
          <form method="post" action={`${ROOT}/launch/broadcast/${b.id}/test?w=${wlId}`} class="wl-inline">
            <Field id={`t-${b.id}`} label="Send a test to" hint="Check how it looks before it goes to anyone else."><Input id={`t-${b.id}`} name="to" type="email" required placeholder="you@example.com" /></Field>
            <Button type="submit" disabled={!canSend}>Send test</Button>
          </form>
          <form method="post" action={`${ROOT}/launch/broadcast/${b.id}/start?w=${wlId}`} class="wl-actions">
            <ConfirmButton id={`go-${b.id}`} variant="default" danger={false} title="Send this to everyone in the group?" body={`It goes to ${formatNumber(b.total)} people in small batches. You can stop it while it runs.`} confirmLabel="Send broadcast">Send to {formatNumber(b.total)} people</ConfirmButton>
            {tested ? <span class="wl-note">Test sent. Ready to go.</span> : <span class="wl-note">Send a test first. Sending unlocks after it.</span>}
          </form>
        </div>
      ) : (
        <p class="wl-note">{formatNumber(b.sent)} sent, {formatNumber(b.failed)} failed, {formatNumber(b.skipped)} skipped{b.started_at ? `, started ${formatDateTime(b.started_at)}` : ''}.</p>
      )}
      {draft || b.status === 'sending' ? (
        <form method="post" action={`${ROOT}/launch/broadcast/${b.id}/cancel?w=${wlId}`}><Button type="submit" size="sm" variant="ghost">{draft ? 'Discard' : 'Stop sending'}</Button></form>
      ) : null}
    </Card>
  );
}

launch.get('/launch', async (c) => {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const [waves, broadcasts, held, canSend, line] = await Promise.all([
    listWaves(db, wl.id), listBroadcasts(db, wl.id), reviewCount(db, wl.id), canSendEmail(c.env), wavePreview(db, wl, 1, {}),
  ]);
  return renderPage(c, { title: `${wl.name} launch`, crumbs: [{ label: 'Waitlist', href: ROOT }, { label: wl.name }] }, (
    <>
      <PageHeader title={wl.name} description={`${formatNumber(line.matching)} people are in line and can be invited.`} />
      {ListNav({ lists, wl, active: 'launch', counts: { review: held } })}
      {await EmailNotice({ c })}
      <Card title="Invite waves" description="Invite the first people in line, or only a group you filter. Each person gets their own code and link, and we track who accepts.">
        <Table
          caption="Invite waves"
          empty={<p class="wl-note">No waves yet. Create the first one below.</p>}
          columns={[{ key: 'name', label: 'Wave' }, { key: 'status', label: 'Status' }, { key: 'size', label: 'Size', numeric: true }, { key: 'sent', label: 'Progress', hideOnMobile: true }, { key: 'act', label: 'Action', srOnly: true }]}
          rows={waves.map((w) => WaveRow({ w, wlId: wl.id }))}
        />
        <form method="post" action={to('launch/wave', wl)} class="wl-form-stack">
          <h3 class="wl-h">New wave</h3>
          <Field id="wv-name" label="Name"><Input id="wv-name" name="name" required maxlength={80} placeholder="First 100" /></Field>
          <Field id="wv-size" label="How many people to invite" hint="The first people in line who match the filters below."><Input id="wv-size" name="size" type="number" min={1} max={5000} required value="100" /></Field>
          <SegmentFields prefix="wv" />
          <Field id="wv-subject" label="Email subject"><Input id="wv-subject" name="subject" required maxlength={150} value="Your invite is ready" /></Field>
          <Field id="wv-body" label="Email message" hint="You can use {{name}}, {{position}} and {{invite_link}}. The invite button is added for you."><Textarea id="wv-body" name="body" rows={5} value={WAVE_BODY} /></Field>
          <div class="wl-actions"><Button type="submit" variant="primary">Create wave</Button></div>
        </form>
      </Card>
      <h2 class="wl-h2">Broadcasts</h2>
      {!canSend ? <Callout tone="warn" title="Sending is off">Set up email to send broadcasts. You can still write a draft.</Callout> : null}
      {broadcasts.length ? broadcasts.map((b) => <BroadcastCard b={b} wlId={wl.id} canSend={canSend} />) : <Card><EmptyState icon="mail" title="No broadcasts yet" body="Write to everyone on the list, or only a group, with an update or a nudge. Every message carries an unsubscribe link." bare /></Card>}
      <Card title="New broadcast" description="Saved as a draft. You send a test to yourself first, then send it to the group.">
        <form method="post" action={to('launch/broadcast', wl)} class="wl-form-stack">
          <Field id="bc-subject" label="Subject"><Input id="bc-subject" name="subject" required maxlength={150} /></Field>
          <Field id="bc-body" label="Message" hint="Separate paragraphs with a blank line. You can use {{name}}, {{referral_link}} and {{position}}."><Textarea id="bc-body" name="body" rows={6} required /></Field>
          <SegmentFields prefix="bc" />
          <div class="wl-actions"><Button type="submit" variant="primary">Save draft</Button></div>
        </form>
      </Card>
    </>
  ));
});

launch.post('/launch/wave', write, async (c) => {
  const { db, base } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const f = await formOf(c);
  return attempt(c, to('launch', wl), 'Wave created. Start it when you are ready.', async () => {
    const wave = await createWave(db, wl, { name: str(f.name), size: str(f.size), subject: str(f.subject), body: str(f.body) }, segmentOf(f), base);
    await audit(c, 'waitlist.wave.created', wl, `Created wave ${wave.name}`);
  });
});

launch.post('/launch/wave/:wid/:action{start|cancel}', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const wave = await db.get<Wave>('wl_waves', c.req.param('wid'));
  const start = c.req.param('action') === 'start';
  return attempt(c, to('launch', wl), start ? 'Wave started. Invites go out in batches.' : 'Wave cancelled.', async () => {
    if (!wave || wave.waitlist_id !== wl.id) throw wlErrors.not_found('That wave does not exist.');
    if (start) {
      if (!(await canSendEmail(c.env))) throw wlErrors.email_off('Set up email before starting a wave.');
      await startWave(c.env, db, wave);
      await audit(c, 'waitlist.wave.started', wl, `Started wave ${wave.name}`);
    } else await cancelWave(db, wave);
  });
});

launch.post('/launch/broadcast', write, async (c) => {
  const { db, base } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const f = await formOf(c);
  return attempt(c, to('launch', wl), null, async () => {
    const seg = segmentOf(f);
    await createBroadcast(db, wl, { subject: str(f.subject), body: str(f.body) }, seg, base);
    const n = await broadcastAudience(db, wl, seg);
    setFlash(c, { kind: 'ok', message: `Draft saved for ${formatNumber(n)} people. Send a test next.` });
  });
});

launch.post('/launch/broadcast/:bid/:action{test|start|cancel}', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const bc = await db.get<Broadcast>('wl_broadcasts', c.req.param('bid'));
  const action = c.req.param('action');
  const f = await formOf(c);
  const ok = { test: 'Test sent. Check your inbox, then send the broadcast.', start: 'Broadcast started. It goes out in batches.', cancel: 'Done.' }[action];
  return attempt(c, to('launch', wl), ok ?? null, async () => {
    if (!bc || bc.waitlist_id !== wl.id) throw wlErrors.not_found('That broadcast does not exist.');
    if (action === 'test') {
      const addr = str(f.to).trim();
      if (!addr.includes('@')) throw errors.validation_failed(undefined, { to: 'Enter an email address for the test.' });
      await sendTest(c.env, db, wl, bc, addr);
    } else if (action === 'start') {
      const started = await startBroadcast(c.env, db, wl, bc);
      await audit(c, 'waitlist.broadcast.started', wl, `Started broadcast to ${started.total} people`);
    } else await cancelBroadcast(db, bc);
  });
});
