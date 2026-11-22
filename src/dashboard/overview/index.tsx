/**
 * Overview, the first screen after sign-in (/app): a card per turned-on module, recent activity and,
 * for admins of a new workspace, a getting-started checklist.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { auditFromRequest } from '../../core/audit';
import { parse } from '../../core/errors';
import { needRole } from '../../core/guards';
import { setSetting } from '../../core/settings';
import type { AppEnv } from '../../env';
import { AppShell, setFlash, takeFlash } from '../../ui';
import { CHECKLIST_SETTING, loadOverview, parseRange } from './data';
import { OverviewView } from './view';

const screen = new Hono<AppEnv>();

screen.get('/', async (c) => {
  const now = Date.now();
  const data = await loadOverview(c, { range: parseRange(c.req.query('days')), now });
  // Built on AppShell so the shell data loaded for the cards is reused: renderPage would load it again,
  // and every module's `count` would run twice.
  c.header('cache-control', 'no-store');
  return c.html(
    <AppShell shell={data.shell} path="/app" title="Overview" crumbs={[{ label: 'Overview' }]} flash={takeFlash(c)}>
      <OverviewView data={data} now={now} />
    </AppShell>,
  );
});

const dismissForm = z.object({ days: z.string().optional() });

screen.post('/overview/dismiss-checklist', async (c) => {
  needRole(c, 'admin');
  const org = c.get('org')!;
  const form = parse(dismissForm, await c.req.parseBody());
  await setSetting(c.env, org.id, CHECKLIST_SETTING, true);
  await auditFromRequest(c, {
    action: 'overview.checklist_dismissed',
    targetType: 'workspace',
    targetId: org.id,
    summary: 'Hid the getting-started checklist on Overview',
  });
  setFlash(c, { kind: 'ok', message: 'Checklist hidden. Every step is still in the sidebar.' });
  const days = parseRange(form.days);
  return c.redirect(days === 30 ? '/app' : `/app?days=${days}`, 303);
});

export default screen;
