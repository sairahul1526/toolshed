/** Form handling for turning modules on and off and for their sample data. Admins and owners only. */
import type { Context } from 'hono';
import { z } from 'zod';
import { auditFromRequest } from '../../core/audit';
import { errors, parse } from '../../core/errors';
import { needRole } from '../../core/guards';
import type { ModuleDef } from '../../core/module';
import { getModule, moduleContext, moduleState, setModuleEnabled, setModuleSample } from '../../core/registry';
import type { AppEnv } from '../../env';
import { setFlash } from '../../ui';
import { FILTERS, hasSampleData, parseListQuery } from './data';
import { listHref } from './view';

const toggleBody = z.object({
  enabled: z.enum(['0', '1']),
  view: z.enum(['list', 'detail']).catch('list'),
  q: z.string().optional(),
  filter: z.enum(FILTERS).optional(),
});

const sampleBody = z.object({ sample: z.enum(['0', '1']) });

/** Looks the module up, or answers 404. A made-up id never reaches the database. */
function moduleOr404(id: string): ModuleDef {
  const def = getModule(id);
  if (!def) throw errors.not_found('There is no module with that name. Go back to the list and pick one.');
  return def;
}

function workspace(c: Context<AppEnv>) {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return org;
}

export async function toggleModule(c: Context<AppEnv>, id: string): Promise<Response> {
  needRole(c, 'admin');
  const org = workspace(c);
  const def = moduleOr404(id);
  const body = parse(toggleBody, await c.req.parseBody());
  const enable = body.enabled === '1';

  const before = await moduleState(c.env, org.id, def.id);
  if (before.enabled === enable) {
    setFlash(c, { kind: 'info', message: `${def.name} is already ${enable ? 'on' : 'off'}.` });
  } else {
    await setModuleEnabled(c.env, org.id, def.id, enable);
    await auditFromRequest(c, {
      action: enable ? 'module.enabled' : 'module.disabled',
      targetType: 'module',
      targetId: def.id,
      summary: enable ? `Turned on ${def.name}` : `Turned off ${def.name}. Its data was kept.`,
    });
    setFlash(c, {
      kind: 'ok',
      message: enable ? `${def.name} is on. It shows up in the sidebar.` : `${def.name} is off. Your data is kept, and it comes back when you turn it on.`,
    });
  }
  const back = body.view === 'detail' ? `/app/modules/${def.id}` : listHref(parseListQuery({ q: body.q, filter: body.filter }));
  return c.redirect(back, 303);
}

export async function setSampleData(c: Context<AppEnv>, id: string): Promise<Response> {
  needRole(c, 'admin');
  const org = workspace(c);
  const def = moduleOr404(id);
  const body = parse(sampleBody, await c.req.parseBody());
  const show = body.sample === '1';
  const back = `/app/modules/${def.id}`;

  if (!hasSampleData(def)) throw errors.bad_request(`${def.name} has no sample data.`);
  const state = await moduleState(c.env, org.id, def.id);
  if (!state.enabled) throw errors.conflict(`Turn ${def.name} on first, then add sample data.`);

  if (state.sample === show) {
    setFlash(c, { kind: 'info', message: show ? `${def.name} is already showing sample data.` : `${def.name} has no sample data to remove.` });
    return c.redirect(back, 303);
  }

  try {
    const ctx = await moduleContext(c.env, org);
    await (show ? def.sampleData : def.clearSampleData)?.(ctx);
  } catch (err) {
    console.error(`[modules] sample data ${show ? 'add' : 'remove'} failed for ${def.id}`, err);
    setFlash(c, { kind: 'error', message: `We couldn’t ${show ? 'add' : 'remove'} the sample data for ${def.name}. Nothing was changed. Try again in a moment.` });
    return c.redirect(back, 303);
  }

  await setModuleSample(c.env, org.id, def.id, show);
  await auditFromRequest(c, {
    action: show ? 'module.sample_added' : 'module.sample_removed',
    targetType: 'module',
    targetId: def.id,
    summary: show ? `Added sample data to ${def.name}` : `Removed sample data from ${def.name}`,
  });
  setFlash(c, { kind: 'ok', message: show ? `Sample data added to ${def.name}.` : `Sample data removed from ${def.name}.` });
  return c.redirect(back, 303);
}
