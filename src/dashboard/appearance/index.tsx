/**
 * Appearance (/app/appearance): the workspace's default dashboard look, public page look and logo.
 * Admins and owners change it; everyone else sees it read-only.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { AppError } from '../../core/errors';
import { needRole } from '../../core/guards';
import { renderPage, setFlash } from '../../ui';
import { ACCENTS, MODES, PUBLIC_PRESETS } from '../../ui/appearance';
import { loadLook, type Look } from './data';
import { resetLook, saveLook } from './actions';
import { AppearanceView, type FormState } from './view';

const screen = new Hono<AppEnv>();

function formFrom(look: Look): FormState {
  return { mode: look.mode, accent: look.accent, preset: look.preset, powered: look.powered, logoUrl: look.logoUrl ?? '' };
}

/** After a failed save: keep what was typed, but a radio can only show a value that exists. */
function formFromPost(look: Look, body: Record<string, unknown>): FormState {
  const keep = (allowed: readonly string[], posted: unknown, fallback: string) => (typeof posted === 'string' && allowed.includes(posted) ? posted : fallback);
  return {
    mode: keep(MODES, body.mode, look.mode),
    accent: keep(ACCENTS, body.accent, look.accent),
    preset: keep(PUBLIC_PRESETS, body.preset, look.preset),
    powered: body.powered === undefined ? look.powered : body.powered === 'on',
    logoUrl: typeof body.logoUrl === 'string' ? body.logoUrl : (look.logoUrl ?? ''),
  };
}

screen.get('/', async (c) => {
  const org = c.get('org')!;
  const { look } = await loadLook(c.env, org.id);
  return renderPage(
    c,
    { title: 'Appearance', crumbs: [{ label: 'Workspace' }, { label: 'Appearance' }] },
    <AppearanceView orgName={org.name} look={look} form={formFrom(look)} canEdit={roleAtLeast(org.role, 'admin')} />,
  );
});

screen.post('/', async (c) => {
  needRole(c, 'admin');
  const org = c.get('org')!;
  const body = await c.req.parseBody();
  try {
    const changed = await saveLook(c, body);
    setFlash(c, { kind: 'ok', message: changed.length ? 'Appearance saved for everyone in this workspace.' : 'Nothing changed, so nothing was saved.' });
    return c.redirect('/app/appearance', 303);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'validation_failed') throw err;
    const { look } = await loadLook(c.env, org.id);
    return renderPage(
      c,
      { title: 'Appearance', crumbs: [{ label: 'Workspace' }, { label: 'Appearance' }], status: 422 },
      <AppearanceView orgName={org.name} look={look} form={formFromPost(look, body)} errors={err.fields ?? {}} canEdit />,
    );
  }
});

screen.post('/reset', async (c) => {
  const changed = await resetLook(c);
  setFlash(c, { kind: 'ok', message: changed.length ? 'Appearance is back to the Toolshed defaults.' : 'Appearance was already using the defaults.' });
  return c.redirect('/app/appearance', 303);
});

export default screen;
