/** The waitlist editor: page text, questions, reward tiers, rules, test mode and the snippets to put it on a site. */
import { Hono } from 'hono';
import { AppError } from '../../../core/errors';
import type { AppEnv } from '../../../env';
import {
  Button, Callout, Card, CodeBlock, CopyField, DangerZone, ConfirmButton, EditorBar, Field, Input, LinkButton, PageHeader, Pill, Select, Table, Textarea,
} from '../../../ui';
import { formatNumber } from '../../../ui/format';
import { previewLink } from '../public';
import { clearTestSignups } from '../review';
import { audit, attempt, EmailNotice, formOf, ListNav, pickList, ROOT, scopeOf, str, to, write, type C, renderPage, Toggle } from './common';
import { addTier, deleteWaitlist, listTiers, questionsFromText, questionsToText, questionsOf, removeTier, updateWaitlist } from '../waitlists';
import { FRAUD_LEVELS, WAITLIST_STATUSES, type Tier, type Waitlist } from '../types';

export const editor = new Hono<AppEnv>();

const FRAUD_LABEL: Record<string, string> = {
  off: 'Off: let everyone in',
  relaxed: 'Relaxed: hold only obvious abuse',
  balanced: 'Balanced: hold likely self-referrals',
  strict: 'Strict: hold anything unusual',
};

/** A date and time field value in UTC, or empty. */
const asLocal = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16) : '');

function fieldsFrom(f: Record<string, unknown>): Record<string, unknown> {
  const on = (k: string) => (f[k] === 'on' ? 1 : 0);
  return {
    name: str(f.name),
    slug: str(f.slug),
    status: str(f.status),
    headline: str(f.headline),
    description: str(f.description),
    button_text: str(f.button_text),
    success_message: str(f.success_message),
    image_url: str(f.image_url),
    show_count: on('show_count'),
    launch_at: str(f.launch_at) ? `${str(f.launch_at)}:00Z` : '',
    questions: questionsFromText(str(f.questions)),
    double_optin: on('double_optin'),
    fraud_level: str(f.fraud_level),
    blocked_domains: str(f.blocked_domains),
    allowed_domains: str(f.allowed_domains),
    disposable_domains: str(f.disposable_domains),
    skip_per_referral: str(f.skip_per_referral),
    head_start: str(f.head_start),
    leaderboard_on: on('leaderboard_on'),
    leaderboard_size: str(f.leaderboard_size),
    invite_url: str(f.invite_url),
  };
}

interface Draft {
  wl: Waitlist;
  values: Record<string, string>;
  checks: Record<string, boolean>;
  errors: Record<string, string>;
}

function draftOf(wl: Waitlist, f?: Record<string, unknown>, errors: Record<string, string> = {}): Draft {
  const from = (k: keyof Waitlist) => (f ? str(f[k]) : String(wl[k] ?? ''));
  const check = (k: keyof Waitlist) => (f ? f[k] === 'on' : wl[k] === 1);
  return {
    wl,
    errors,
    checks: { show_count: check('show_count'), double_optin: check('double_optin'), leaderboard_on: check('leaderboard_on') },
    values: {
      name: from('name'), slug: from('slug'), status: from('status'), headline: from('headline'), description: from('description'), button_text: from('button_text'),
      success_message: from('success_message'), image_url: from('image_url'), launch_at: f ? str(f.launch_at) : asLocal(wl.launch_at),
      questions: f ? str(f.questions) : questionsToText(questionsOf(wl)), fraud_level: from('fraud_level'), blocked_domains: from('blocked_domains'),
      allowed_domains: from('allowed_domains'), disposable_domains: from('disposable_domains'), skip_per_referral: from('skip_per_referral'),
      head_start: from('head_start'), leaderboard_size: from('leaderboard_size'), invite_url: from('invite_url'),
    },
  };
}

function Tiers({ wl, tiers }: { wl: Waitlist; tiers: Tier[] }) {
  return (
    <Card id="tiers" title="Reward tiers" description="People reach a tier when enough of the friends they invited have confirmed their email.">
      <Table
        caption="Reward tiers"
        empty="No tiers yet. Add one below, for example 3 referrals for early access."
        columns={[
          { key: 'need', label: 'Referrals', numeric: true },
          { key: 'name', label: 'Tier' },
          { key: 'reward', label: 'Reward', hideOnMobile: true },
          { key: 'act', label: 'Remove', srOnly: true },
        ]}
        rows={tiers.map((t) => ({
          need: formatNumber(t.referrals_required),
          name: t.name,
          reward: t.reward_text || 'None',
          act: (
            <form method="post" action={to('edit/tier/' + t.id + '/delete', wl)}>
              <Button type="submit" size="sm" variant="ghost" aria-label={`Remove tier ${t.name}`}>Remove</Button>
            </form>
          ),
        }))}
      />
      <form method="post" action={to('edit/tier', wl)} class="wl-tier-form">
        <Field id="tier-need" label="Referrals needed"><Input id="tier-need" name="referrals_required" type="number" min={1} max={10000} required placeholder="3" /></Field>
        <Field id="tier-name" label="Tier name"><Input id="tier-name" name="name" required maxlength={60} placeholder="Early access" /></Field>
        <Field id="tier-reward" label="Reward" optional><Input id="tier-reward" name="reward_text" maxlength={300} placeholder="Skip the line and get a month free" /></Field>
        <Button type="submit" icon="plus">Add tier</Button>
      </form>
    </Card>
  );
}

function Snippets({ base, wl }: { base: string; wl: Waitlist }) {
  const page = `${base}/w/${wl.slug}`;
  return (
    <Card title="Put it on your site" description="Four ways to collect signups. None of them set cookies.">
      <h3 class="wl-h">Hosted page</h3>
      <CopyField label="page link" value={page} secret={false} />
      <h3 class="wl-h">Embed on a page</h3>
      <CodeBlock label="embed script" code={`<div data-toolshed-waitlist="${wl.slug}"></div>\n<script async src="${base}/m/waitlist/embed.js"></script>`} />
      <h3 class="wl-h">Frame it yourself</h3>
      <CodeBlock label="iframe" code={`<iframe src="${page}/embed" title="Join the waitlist" width="100%" height="420" loading="lazy"></iframe>`} />
      <h3 class="wl-h">Your own form</h3>
      <CodeBlock label="HTML form" code={`<form method="post" action="${page}/join">\n  <input type="email" name="email" required>\n  <input type="text" name="website" hidden tabindex="-1" autocomplete="off">\n  <button>Join</button>\n</form>`} />
      <h3 class="wl-h">JSON API</h3>
      <CodeBlock label="curl example" code={`curl -X POST ${page}/join \\\n  -H "content-type: application/json" \\\n  -d '{"email":"jo@example.com","ref":"CODE"}'`} />
    </Card>
  );
}

async function show(c: C, wl: Waitlist, lists: Waitlist[], draft: Draft, status: 200 | 422 = 200): Promise<Response> {
  const { db, base } = scopeOf(c);
  const [tiers, preview, test] = await Promise.all([
    listTiers(db, wl.id),
    previewLink(c.env, base, wl),
    db.first<{ n: number }>('SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 1', wl.id),
  ]);
  const { values: v, checks, errors } = draft;
  const err = (k: string) => errors[k];
  const text = (k: string, label: string, extra: { hint?: string; optional?: boolean; type?: string; max?: number } = {}) => (
    <Field id={`f-${k}`} label={label} hint={extra.hint} optional={extra.optional} error={err(k)}>
      <Input id={`f-${k}`} name={k} type={extra.type ?? 'text'} value={v[k]} maxlength={extra.max} invalid={Boolean(err(k))} />
    </Field>
  );
  return renderPage(c, { title: wl.name, status, crumbs: [{ label: 'Waitlist', href: ROOT }, { label: wl.name }] }, (
    <>
      <PageHeader
        title={wl.name}
        description={<><Pill tone={wl.status === 'live' ? 'good' : 'neutral'}>{wl.status}</Pill> <a href={`/w/${wl.slug}`}>{base}/w/{wl.slug}</a></>}
        actions={<LinkButton href={preview} icon="eye" target="_blank" rel="noopener">Preview page</LinkButton>}
      />
      {ListNav({ lists, wl, active: 'edit' })}
      {await EmailNotice({ c })}
      {c.req.query('created') ? (
        <Callout tone="good" title="Waitlist created">Add a headline below, then use Preview page to try the signup. Preview signups are marked as tests and are left out of your numbers.</Callout>
      ) : null}
      {Object.keys(errors).length ? <Callout tone="bad" title="Some fields need fixing">Check the fields marked below. Nothing was saved.</Callout> : null}
      <div class="wl-editor">
        <form method="post" action={to('edit', wl)} class="wl-form-stack" id="editor-form">
          <Card title="Signup page">
            {text('name', 'Name', { max: 80 })}
            {text('slug', 'Page address', { hint: `Shown as /w/${v.slug || 'your-address'}`, max: 40 })}
            <Field id="f-status" label="Status" hint="Draft pages are only visible through Preview page. Paused pages show a closed message.">
              <Select id="f-status" name="status" value={v.status} options={WAITLIST_STATUSES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))} />
            </Field>
            {text('headline', 'Headline', { max: 120 })}
            <Field id="f-description" label="Description" error={err('description')}><Textarea id="f-description" name="description" value={v.description} maxlength={600} rows={3} /></Field>
            {text('button_text', 'Button text', { max: 40 })}
            {text('success_message', 'Thank you message', { optional: true, max: 300 })}
            {text('image_url', 'Image address', { optional: true, hint: 'A full https address. Uploading images is not built in yet.' })}
            <Toggle name="show_count" label="Show how many people have joined" checked={checks.show_count} />
            <Field id="f-launch" label="Opens on" optional hint="Shows a countdown note on the page. Dates are in UTC.">
              <Input id="f-launch" name="launch_at" type="datetime-local" value={v.launch_at} />
            </Field>
          </Card>
          <Card title="Questions" description="Up to 5, one per line, as label | type | required or optional | choices. Types: text, longtext, select, checkbox.">
            <Field id="f-questions" label="Questions" error={err('questions')}>
              <Textarea id="f-questions" name="questions" value={v.questions} rows={4} placeholder={'What will you use it for? | text | optional\nTeam size | select | required | 1-5, 6-20, 21+'} />
            </Field>
          </Card>
          <Card title="Referrals and the leaderboard">
            {text('skip_per_referral', 'Places gained for each confirmed friend', { type: 'number', hint: 'Set 0 for a plain first-come list.' })}
            {text('head_start', 'Head start', { type: 'number', hint: 'Added to everyone’s place, so a new list does not start at 1.' })}
            <Toggle name="leaderboard_on" label="Show a public leaderboard" checked={checks.leaderboard_on} />
            {text('leaderboard_size', 'People on the leaderboard', { type: 'number' })}
            {text('invite_url', 'Where invited people go', { optional: true, hint: 'Your sign up page. We add ?invite=CODE to it.' })}
          </Card>
          <Card title="Email and abuse rules">
            <Toggle name="double_optin" label="Ask people to confirm their email" checked={checks.double_optin} />
            <p class="wl-note">Without email set up, people join without confirming and are marked unconfirmed. Referrals only count once the friend has confirmed.</p>
            <Field id="f-fraud" label="Held for review" hint="Held signups wait in the review queue, with the reason shown.">
              <Select id="f-fraud" name="fraud_level" value={v.fraud_level} options={FRAUD_LEVELS.map((l) => ({ value: l, label: FRAUD_LABEL[l]! }))} />
            </Field>
            <Field id="f-blocked" label="Blocked email domains" optional hint="One per line or comma separated."><Textarea id="f-blocked" name="blocked_domains" value={v.blocked_domains} rows={2} /></Field>
            <Field id="f-allowed" label="Only allow these domains" optional hint="Leave empty to allow all."><Textarea id="f-allowed" name="allowed_domains" value={v.allowed_domains} rows={2} /></Field>
            <Field id="f-disposable" label="Throwaway email domains" optional hint="Replaces the built-in list when filled in."><Textarea id="f-disposable" name="disposable_domains" value={v.disposable_domains} rows={2} /></Field>
          </Card>
          <EditorBar back={{ href: ROOT, label: 'All waitlists' }} title="Unsaved changes are lost when you leave" actions={<Button type="submit" variant="primary">Save changes</Button>} />
        </form>
        <div class="wl-side">
          <Card title="Preview" description="The page as visitors see it, as of the last save.">
            <iframe class="wl-frame" src={preview} title="Signup page preview" loading="lazy"></iframe>
          </Card>
          <Card title="Test mode" description="Signups made from Preview page are marked as tests, never counted in stats and cleared in one click.">
            <p><strong>{formatNumber(test?.n ?? 0)}</strong> test signups right now.</p>
            <form method="post" action={to('edit/test/clear', wl)}>
              <Button type="submit" disabled={!test?.n}>Clear test signups</Button>
            </form>
          </Card>
        </div>
      </div>
      <Tiers wl={wl} tiers={tiers} />
      <Snippets base={base} wl={wl} />
      <DangerZone
        items={[{
          title: 'Delete this waitlist',
          description: 'Removes the page and every signup on it. This cannot be undone.',
          action: (
            <ConfirmButton id="del-wl" title="Delete this waitlist?" body="Every signup, invite and email record on this waitlist is deleted for good." confirmLabel="Delete waitlist" formAction={to('edit/delete', wl)}>
              Delete waitlist
            </ConfirmButton>
          ),
        }]}
      />
    </>
  ));
}

editor.get('/edit', async (c) => {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  return show(c, wl, lists, draftOf(wl));
});

editor.post('/edit', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl, lists } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const form = await formOf(c);
  try {
    const saved = await updateWaitlist(db, wl.id, fieldsFrom(form));
    await audit(c, 'waitlist.updated', saved, `Changed waitlist ${saved.name}`);
    return attempt(c, to('edit', saved), 'Saved.', async () => undefined);
  } catch (err) {
    if (!(err instanceof AppError) || !err.fields) throw err;
    return show(c, wl, lists, draftOf(wl, form, err.fields), 422);
  }
});

editor.post('/edit/tier', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  const f = await formOf(c);
  return attempt(c, to('edit', wl) + '#tiers', 'Tier added.', async () => {
    await addTier(db, wl.id, { referrals_required: str(f.referrals_required), name: str(f.name), reward_text: str(f.reward_text) });
  });
});

editor.post('/edit/tier/:tid/delete', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  return attempt(c, to('edit', wl), 'Tier removed.', () => removeTier(db, wl.id, c.req.param('tid')));
});

editor.post('/edit/test/clear', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  return attempt(c, to('edit', wl), 'Test signups cleared.', async () => {
    await clearTestSignups(db, wl.id);
  });
});

editor.post('/edit/delete', write, async (c) => {
  const { db } = scopeOf(c);
  const { wl } = await pickList(c, db);
  if (!wl) return c.redirect(ROOT, 303);
  return attempt(c, ROOT, `Deleted ${wl.name}.`, async () => {
    await deleteWaitlist(db, wl.id);
    await audit(c, 'waitlist.deleted', wl, `Deleted waitlist ${wl.name}`);
  });
});
