/**
 * Get started (/app/welcome): the first screen of a new workspace. Cards that turn a module on and
 * open it, the steps left to finish setting up, the sample data switch and a few facts about the
 * install. For workspace admins and owners; everyone else is sent to Overview.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { auditFromRequest } from '../../core/audit';
import { errors, parse } from '../../core/errors';
import { needRole } from '../../core/guards';
import { HIDDEN_SETTING, SAMPLE_SETTING } from '../../core/onboarding';
import { allModules, getModule, moduleContext, moduleStates, enableModuleOnce, setModuleSample } from '../../core/registry';
import { getSetting, setSetting } from '../../core/settings';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { AppShell, setFlash, takeFlash } from '../../ui';
import { BASE, hasSample, loadWelcome } from './data';
import { WelcomeView } from './view';

const screen = new Hono<AppEnv>();

function workspace(c: Context<AppEnv>) {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return org;
}

screen.get('/', async (c) => {
  if (!roleAtLeast(workspace(c).role, 'admin')) return c.redirect('/app');
  const data = await loadWelcome(c);
  // Built on AppShell so the shell data (and the setup steps in it) is loaded once, not twice.
  c.header('cache-control', 'no-store');
  return c.html(
    <AppShell shell={data.shell} path={BASE} title="Get started" crumbs={[{ label: 'Get started' }]} flash={takeFlash(c)}>
      <WelcomeView data={data} />
    </AppShell>,
  );
});

const startBody = z.object({ module: z.string().min(1).max(64) });

/** A card was pressed: turn the module on, add sample rows if the switch is on, and open it. */
screen.post('/start', async (c) => {
  needRole(c, 'admin');
  const org = workspace(c);
  const body = parse(startBody, await c.req.parseBody());
  const def = getModule(body.module);
  if (!def?.onboarding) throw errors.not_found('There is no module with that name. Go back and pick a card.');
  const open = def.onboarding.href ?? (def.dashboard ? `/app/${def.id}` : `/app/modules/${def.id}`);

  const before = (await moduleStates(c.env, org.id)).get(def.id);
  // Only the press that really turned it on goes further: a double click or a second tab just opens it.
  if (before?.enabled || !(await enableModuleOnce(c.env, org.id, def.id))) return c.redirect(open, 303);

  // A module that was on before, then turned off, keeps its sample rows. Do not add a second set.
  let sample = before?.sample === true;
  if (!sample && hasSample(def) && (await getSetting<boolean>(c.env, org.id, SAMPLE_SETTING, true)) === true) {
    try {
      await def.sampleData!(await moduleContext(c.env, org));
      await setModuleSample(c.env, org.id, def.id, true);
      sample = true;
    } catch (err) {
      // Sample rows are a nicety. A module that fails to make them still opens.
      console.error(`[welcome] sample data for ${def.id} failed`, err);
    }
  }
  await auditFromRequest(c, {
    action: 'module.enabled',
    targetType: 'module',
    targetId: def.id,
    summary: `Turned on ${def.name}`,
    meta: { sample, from: 'welcome' },
  });
  setFlash(c, { kind: 'ok', message: sample ? `${def.name} is on, with sample data to look around.` : `${def.name} is on. It shows up in the sidebar.` });
  return c.redirect(open, 303);
});

const sampleBody = z.object({ sample: z.enum(['0', '1']) });

/**
 * The switch. Off takes the sample rows out of every module that has them. On only changes what the
 * cards do from now on: it never writes rows into a module that is already in use.
 */
screen.post('/sample', async (c) => {
  needRole(c, 'admin');
  const org = workspace(c);
  const show = parse(sampleBody, await c.req.parseBody()).sample === '1';
  const states = await moduleStates(c.env, org.id);
  const ctx = await moduleContext(c.env, org);

  const changed: string[] = [];
  const failed: string[] = [];
  for (const def of allModules()) {
    const state = states.get(def.id);
    if (show || !state?.enabled || !state.sample || !hasSample(def)) continue;
    try {
      await def.clearSampleData!(ctx);
      await setModuleSample(c.env, org.id, def.id, false);
      changed.push(def.name);
    } catch (err) {
      console.error(`[welcome] sample data remove failed for ${def.id}`, err);
      failed.push(def.name);
    }
  }
  await setSetting(c.env, org.id, SAMPLE_SETTING, show);
  await auditFromRequest(c, {
    action: show ? 'onboarding.sample_on' : 'onboarding.sample_off',
    targetType: 'workspace',
    targetId: org.id,
    summary: show ? 'Turned sample data on' : 'Turned sample data off',
    meta: { modules: changed, failed },
  });

  const list = (names: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
  if (failed.length > 0) {
    setFlash(c, { kind: 'error', message: `We couldn’t remove the sample data from ${list(failed)}. Open the module from Modules and try again there.` });
  } else if (show) {
    setFlash(c, { kind: 'ok', message: 'Sample data is on. Modules you start here come with example rows.' });
  } else {
    setFlash(c, { kind: 'ok', message: changed.length > 0 ? `Sample data removed from ${list(changed)}. Your own data was not touched.` : 'Sample data is off. Modules you start here begin empty.' });
  }
  return c.redirect(BASE, 303);
});

const sidebarBody = z.object({ hidden: z.enum(['0', '1']) });

screen.post('/sidebar', async (c) => {
  needRole(c, 'admin');
  const org = workspace(c);
  const hidden = parse(sidebarBody, await c.req.parseBody()).hidden === '1';
  await setSetting(c.env, org.id, HIDDEN_SETTING, hidden);
  await auditFromRequest(c, {
    action: hidden ? 'onboarding.hidden' : 'onboarding.shown',
    targetType: 'workspace',
    targetId: org.id,
    summary: hidden ? 'Hid Get started from the sidebar' : 'Put Get started back in the sidebar',
  });
  setFlash(c, { kind: 'ok', message: hidden ? 'Get started is out of the sidebar. This page stays at this address.' : 'Get started is back in the sidebar.' });
  return c.redirect(BASE, 303);
});

export default screen;
