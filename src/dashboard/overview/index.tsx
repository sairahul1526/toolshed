/**
 * Overview, the first screen after sign-in (/app): a card per turned-on module and recent activity.
 * The setup steps of a new workspace live on Get started (/app/welcome).
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { AppShell, takeFlash } from '../../ui';
import { loadOverview, parseRange } from './data';
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

export default screen;
