/**
 * Modules (/app/modules): every product this install ships, which ones the workspace has on, and a
 * page per module. Anyone in the workspace can look; admins and owners can switch modules.
 */
import { Hono } from 'hono';
import { errors } from '../../core/errors';
import { getModule } from '../../core/registry';
import { roleAtLeast } from '../../env';
import type { AppEnv } from '../../env';
import { renderPage } from '../../ui';
import { setSampleData, toggleModule } from './actions';
import { countRows, filterRows, loadRow, loadRows, parseListQuery } from './data';
import { ModuleDetail, ModulesPage } from './view';

const screen = new Hono<AppEnv>();

screen.get('/', async (c) => {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  const query = parseListQuery({ q: c.req.query('q'), filter: c.req.query('filter') });
  const rows = await loadRows(c.env, org);
  return renderPage(
    c,
    { title: 'Modules', crumbs: [{ label: 'Modules' }] },
    <ModulesPage orgName={org.name} rows={filterRows(rows, query)} counts={countRows(rows)} query={query} canEdit={roleAtLeast(org.role, 'admin')} />,
  );
});

screen.get('/:id', async (c) => {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  const def = getModule(c.req.param('id'));
  if (!def) throw errors.not_found('There is no module with that name. Go back to the list and pick one.');
  const row = await loadRow(c.env, org, def);
  return renderPage(
    c,
    { title: def.name, crumbs: [{ label: 'Modules', href: '/app/modules' }, { label: def.name }] },
    <ModuleDetail row={row} canEdit={roleAtLeast(org.role, 'admin')} />,
  );
});

screen.post('/:id/toggle', (c) => toggleModule(c, c.req.param('id')));
screen.post('/:id/sample', (c) => setSampleData(c, c.req.param('id')));

export default screen;
