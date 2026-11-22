/** General: the workspace name and its address (short name). */
import type { FieldErrors } from '../../core/errors';
import { Button, Callout, Card, Field, Input, Section } from '../../ui';
import { BASE } from './frame';

export interface GeneralValues {
  name: string;
  slug: string;
}

export interface GeneralProps {
  values: GeneralValues;
  /** The workspace's own name, for the description. Stays put while the field holds unsaved input. */
  orgName: string;
  /** The address people use to reach the app, without a scheme, for the text before the short name. */
  host: string;
  errors?: FieldErrors;
  /** A refusal that is not about one field. */
  message?: string | null;
  canEdit: boolean;
}

export function GeneralTab({ values, orgName, host, errors = {}, message = null, canEdit }: GeneralProps) {
  return (
    <Section title="Workspace" description={`Everyone in ${orgName} sees these.`}>
      {!canEdit ? <Callout title="You can look, not change">Only workspace admins and owners can rename the workspace or change its address. Ask one of them.</Callout> : null}
      {message ? (
        <Callout tone="bad" title="Nothing was saved">
          {message}
        </Callout>
      ) : null}
      <form method="post" action={`${BASE}/general`} autocomplete="off">
        <Card
          footer={
            canEdit ? (
              <>
                <span class="spacer" />
                <Button type="submit" variant="primary" size="sm">
                  Save
                </Button>
              </>
            ) : null
          }
        >
          <div class="form">
            <Field id="name" label="Name" error={errors.name}>
              <Input id="name" name="name" value={values.name} required maxlength={60} invalid={Boolean(errors.name)} disabled={!canEdit} />
            </Field>
            <Field id="slug" label="Address" hint="Letters, numbers and dashes. Changing it breaks old bookmarks that use the old one." error={errors.slug}>
              <Input id="slug" name="slug" value={values.slug} required maxlength={40} prefix={`${host}/`} invalid={Boolean(errors.slug)} disabled={!canEdit} />
            </Field>
          </div>
        </Card>
      </form>
    </Section>
  );
}
