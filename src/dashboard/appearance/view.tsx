/** The Appearance screen: a preview of what is saved, then the settings form, then reset. */
import type { Child } from 'hono/jsx';
import type { FieldErrors } from '../../core/errors';
import { Button, Callout, Card, ConfirmButton, Field, Icon, Input, PageHeader, Section, Switch } from '../../ui';
import { ACCENTS, type PublicPreset } from '../../ui/appearance';
import type { Look } from './data';
import { DashboardSketch, PresetThumb, PublicSketch, Swatch } from './preview';

export interface FormState {
  mode: string;
  accent: string;
  preset: string;
  powered: boolean;
  logoUrl: string;
}

export interface AppearanceViewProps {
  orgName: string;
  /** What is saved. The preview and the "current logo" line show this. */
  look: Look;
  /** What the controls show: the saved values, or the person's input after a failed save. */
  form: FormState;
  errors?: FieldErrors;
  canEdit: boolean;
}

const MODE_OPTIONS = [
  { value: 'system', label: 'System', hint: 'Follows each person’s device.', icon: 'laptop' },
  { value: 'light', label: 'Light', hint: 'Light for everyone by default.', icon: 'sun' },
  { value: 'dark', label: 'Dark', hint: 'Dark for everyone by default.', icon: 'moon' },
];

const ACCENT_LABELS: Record<(typeof ACCENTS)[number], string> = { lime: 'Lime', mint: 'Mint', sky: 'Sky', violet: 'Violet', rose: 'Rose', amber: 'Amber' };

const PRESET_OPTIONS: { value: PublicPreset; label: string; hint: string }[] = [
  { value: 'paper', label: 'Paper', hint: 'Plain and neutral.' },
  { value: 'warm', label: 'Warm', hint: 'Cream with a copper accent.' },
  { value: 'cobalt', label: 'Cobalt', hint: 'Cool blue.' },
  { value: 'dusk', label: 'Dusk', hint: 'Soft violet.' },
];

interface CardOption {
  value: string;
  label: string;
  hint?: string;
  art: Child;
}

/** Choice cards over native radio buttons: they submit with the form and work without JavaScript. */
function CardGroup({ name, label, options, value, disabled, columns, error }: { name: string; label: string; options: CardOption[]; value: string; disabled: boolean; columns?: 2; error?: string }) {
  return (
    <div>
      <p class="section-label" id={`${name}-label`}>
        {label}
      </p>
      <div class={columns === 2 ? 'choices two' : 'choices'} role="radiogroup" aria-labelledby={`${name}-label`}>
        {options.map((o) => (
          <label class="choice">
            <input class="sr-only" type="radio" name={name} value={o.value} checked={o.value === value} disabled={disabled} />
            {o.art}
            <b>{o.label}</b>
            {o.hint ? <span>{o.hint}</span> : null}
          </label>
        ))}
      </div>
      {error ? (
        <p class="err-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Preview({ look, orgName }: { look: Look; orgName: string }) {
  const dashboardSchemes = look.mode === 'system' ? (['light', 'dark'] as const) : ([look.mode] as const);
  return (
    <Section title="Preview" description="This is what is saved now. Change the settings below and save to update it.">
      <Card title="Dashboard" description={look.mode === 'system' ? 'Shown in light and dark, because each person’s device decides.' : `Shown in ${look.mode} mode.`}>
        <div class="grid-2">
          {dashboardSchemes.map((scheme) => (
            <div>
              <DashboardSketch accent={look.accent} scheme={scheme} name={orgName} />
              <p class="hint">{scheme === 'light' ? 'Light' : 'Dark'}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Public page" description="A form or status page, in light and dark. Visitors see the one their device uses.">
        <div class="grid-2">
          {(['light', 'dark'] as const).map((scheme) => (
            <div>
              <PublicSketch preset={look.preset} scheme={scheme} name={orgName} powered={look.powered} />
              <p class="hint">{scheme === 'light' ? 'Light' : 'Dark'}</p>
            </div>
          ))}
        </div>
      </Card>
    </Section>
  );
}

export function AppearanceView({ orgName, look, form, errors = {}, canEdit }: AppearanceViewProps) {
  const disabled = !canEdit;
  const failed = Object.keys(errors).length > 0;
  return (
    <>
      <PageHeader
        title="Appearance"
        soft={orgName}
        description="How the dashboard and your public pages look for everyone in this workspace."
        actions={
          canEdit ? (
            <form method="post" action="/app/appearance/reset">
              <ConfirmButton
                id="reset"
                danger={false}
                title="Reset to the Toolshed defaults?"
                confirmLabel="Reset appearance"
                body="The dashboard mode, accent, public page look and the Powered by Toolshed line go back to the Toolshed defaults, and the logo address is removed. This applies to everyone in the workspace. You can set them again at any time."
              >
                Reset to defaults
              </ConfirmButton>
            </form>
          ) : null
        }
      />
      {!canEdit ? (
        <Callout title="You can look, not change">Only workspace admins and owners can change the appearance. Ask one of them if something should look different.</Callout>
      ) : null}
      {failed ? (
        <Callout tone="bad" title="Nothing was saved">
          Fix the fields marked below, then save again.
        </Callout>
      ) : null}

      <form method="post" action="/app/appearance" autocomplete="off">
        <Preview look={look} orgName={orgName} />
        <Section title="Dashboard" description="The default look of the dashboard for everyone in this workspace.">
          <Card>
            <div class="form">
              <CardGroup
                name="mode"
                label="Default mode"
                value={form.mode}
                disabled={disabled}
                error={errors.mode}
                options={MODE_OPTIONS.map((o) => ({ ...o, art: <span class="tile"><Icon name={o.icon} /></span> }))}
              />
              <p class="hint">
                This is the workspace default. Each person can still switch light or dark just for themselves with the moon button at the top of the page; that choice stays in their own browser and wins over this one.
              </p>
              <CardGroup
                name="accent"
                label="Accent colour"
                value={form.accent}
                disabled={disabled}
                error={errors.accent}
                options={ACCENTS.map((a) => ({ value: a, label: ACCENT_LABELS[a], art: <Swatch accent={a} /> }))}
              />
              <p class="hint">Used for focus rings, the current page in the sidebar and progress bars.</p>
            </div>
          </Card>
        </Section>

        <Section title="Public pages" description="Forms, short-link pages, the status page and anything else visitors see.">
          <Card>
            <div class="form">
              <CardGroup
                name="preset"
                label="Look"
                columns={2}
                value={form.preset}
                disabled={disabled}
                error={errors.preset}
                options={PRESET_OPTIONS.map((o) => ({ ...o, art: <PresetThumb preset={o.value} /> }))}
              />
              <p class="hint">Each look has a light and a dark version. Visitors see the one their device uses.</p>
            </div>
          </Card>
          <Card flush>
            <ul class="rows">
              <li>
                <span class="row-text">
                  <b>Show “Powered by Toolshed”</b>
                  <span>A small link at the bottom of public pages. Optional, and always free.</span>
                  {errors.powered ? <span class="err-text" role="alert">{errors.powered}</span> : null}
                </span>
                <input type="hidden" name="powered" value="off" disabled={disabled} />
                <Switch label="Show Powered by Toolshed" name="powered" value="on" checked={form.powered} disabled={disabled} />
              </li>
            </ul>
          </Card>
        </Section>

        <Section title="Logo" description="Your workspace logo, for the emails Toolshed sends from here.">
          <Card>
            <div class="form">
              <Field
                id="logoUrl"
                label="Logo address"
                optional
                error={errors.logoUrl}
                hint="A public https address of a PNG, JPEG or WebP image. Leave it empty to use the Toolshed mark. Emails fetch it from there; Toolshed does not copy or host it."
              >
                <Input id="logoUrl" name="logoUrl" type="text" inputmode="url" value={form.logoUrl} maxlength={2048} placeholder="https://example.com/logo.png" invalid={Boolean(errors.logoUrl)} disabled={disabled} />
              </Field>
              <p class="hint row-text">
                <span>{look.logoUrl ? `Saved logo address: ${look.logoUrl}` : 'No logo address saved. Emails use the Toolshed mark.'}</span>
              </p>
            </div>
          </Card>
        </Section>

        {canEdit ? (
          <div class="row">
            <Button type="submit" variant="primary">
              Save appearance
            </Button>
            <span class="hint">Applies to everyone in this workspace.</span>
          </div>
        ) : null}
      </form>
    </>
  );
}
