/** Workspace-wide choices: the daily limit, server PNG, and the outside sites pictures may come from. */
import { Hono } from 'hono';
import { auditFromRequest } from '../../../core/audit';
import type { FieldErrors } from '../../../core/errors';
import { needRole } from '../../../core/guards';
import type { AppEnv } from '../../../env';
import { Button, Callout, Card, Checkbox, Field, Input, PageHeader, Textarea } from '../../../ui';
import { HOME, checked, flashAndGo, isAdmin, numberIn, page, plainError, readForm, text, type Ctx } from '../dash-shared';
import { scopeOf } from '../http';
import { MAX_DAILY_CAP, getSettings, saveSettings } from '../settings';

interface State {
  values?: { dailyCap: string; allowedHosts: string; serverPng: boolean };
  fields?: FieldErrors;
  message?: string;
}

async function settingsPage(c: Ctx, state: State = {}): Promise<Response> {
  const s = scopeOf(c);
  const admin = isAdmin(c);
  const saved = await getSettings(s.env, s.db.orgId);
  const v = state.values ?? { dailyCap: String(saved.dailyCap), allowedHosts: saved.allowedHosts.join('\n'), serverPng: saved.serverPng };
  const f = state.fields ?? {};
  // A problem with one site in the list comes back under `allowedHosts.<n>`.
  const hostError = Object.entries(f).find(([key]) => key.startsWith('allowedHosts'))?.[1];
  return page(c, 'Settings', (
    <>
      <PageHeader title="Settings" description="These apply to every template in this workspace." />
      {state.message ? <Callout tone="bad" title="Not saved">{state.message}</Callout> : null}
      {admin ? null : <Callout tone="info">Workspace admins can change these settings. You can look.</Callout>}
      <Card>
        <form method="post" action={`${HOME}/settings`} class="form">
          <fieldset class="img-fieldset" disabled={!admin}>
            <Field id="set-cap" label="New images a day" hint={`Stops a leaked or guessed URL from running up your usage. Images already made are always served. 0 to ${MAX_DAILY_CAP.toLocaleString('en-US')}; the count starts again at midnight UTC.`} error={f.dailyCap}>
              <Input id="set-cap" name="dailyCap" inputmode="numeric" value={v.dailyCap} required invalid={Boolean(f.dailyCap)} />
            </Field>
            <Checkbox
              name="serverPng"
              value="1"
              checked={v.serverPng}
              label="Draw PNG files on the server"
              description="Needs the Workers Paid plan: one PNG takes about 30 to 70 ms of CPU time and the free plan allows 10 ms. Leave it off on the free plan. SVG by URL and PNG made in the browser work either way."
            />
            <Field id="set-hosts" label="Sites pictures may come from" hint="One site per line, such as images.example.com. A template can then use https:// pictures from these sites. Each picture is fetched once and kept. Uploaded pictures always work." error={hostError} optional>
              <Textarea id="set-hosts" name="allowedHosts" rows={4} value={v.allowedHosts} class="mono" invalid={Boolean(hostError)} />
            </Field>
            {admin ? (
              <div class="img-row">
                <Button type="submit" variant="primary">Save settings</Button>
              </div>
            ) : null}
          </fieldset>
        </form>
      </Card>
    </>
  ), { status: state.message ? 422 : 200 });
}

const settings = new Hono<AppEnv>();

settings.get('/settings', (c) => settingsPage(c));

settings.post('/settings', async (c) => {
  needRole(c, 'admin');
  const s = scopeOf(c);
  const form = await readForm(c);
  const values = { dailyCap: text(form, 'dailyCap'), allowedHosts: text(form, 'allowedHosts'), serverPng: checked(form, 'serverPng') };
  try {
    const next = await saveSettings(s.env, s.db.orgId, {
      serverPng: values.serverPng,
      // Anything typed that is not a number goes through as it is, so the form can say what is wrong with it.
      dailyCap: numberIn(form, 'dailyCap') ?? Number.NaN,
      allowedHosts: values.allowedHosts.split(/[\s,]+/).filter(Boolean),
    });
    await auditFromRequest(c, { action: 'images.settings.changed', targetType: 'module', targetId: 'images', summary: 'Changed the Images settings', meta: { ...next } });
    return flashAndGo(c, 'ok', 'Settings saved.', `${HOME}/settings`);
  } catch (err) {
    const { message, fields } = plainError(err);
    return settingsPage(c, { values, fields, message });
  }
});

export { settings };
