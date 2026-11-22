/** One workspace, as the owner of the install sees it: rename it or delete it. */
import type { FieldErrors } from '../../core/errors';
import { Button, Callout, Card, Field, formatDate, Input, KeyValueList, LinkButton, PageHeader } from '../../ui';
import { BASE, clip, workspaceHref } from './data';

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface WorkspaceForms {
  name: string;
  slug: string;
  deleteConfirm: string;
  errors: FieldErrors;
}

export const workspaceForms = (w: WorkspaceRecord): WorkspaceForms => ({ name: w.name, slug: w.slug, deleteConfirm: '', errors: {} });

export function WorkspacePage({ workspace, forms }: { workspace: WorkspaceRecord; forms: WorkspaceForms }) {
  const { errors } = forms;
  const href = workspaceHref(workspace.id);
  return (
    <>
      <PageHeader
        title={clip(workspace.name, 80)}
        description={<span class="mono">{workspace.slug}</span>}
        actions={
          <LinkButton href={`${BASE}?tab=workspaces`} icon="left">
            All workspaces
          </LinkButton>
        }
      />
      <div class="stack">
        <Card title="Rename" description="The name is what people see. The short name is part of the workspace’s links.">
          <form method="post" action={`${href}/rename`} class="stack">
            <div class="form-row">
              <Field id="ws-name" label="Name" error={errors.name}>
                <Input id="ws-name" name="name" value={forms.name} required maxlength={60} autocomplete="off" invalid={!!errors.name} />
              </Field>
              <Field id="ws-slug" label="Short name" hint="Lower case letters, numbers and dashes." error={errors.slug}>
                <Input id="ws-slug" name="slug" value={forms.slug} required maxlength={40} autocomplete="off" spellcheck={false} invalid={!!errors.slug} />
              </Field>
            </div>
            <div>
              <Button type="submit" variant="primary" icon="check">
                Save changes
              </Button>
            </div>
          </form>
        </Card>
        <Card title="Details">
          <KeyValueList items={[{ label: 'Made', value: formatDate(Date.parse(workspace.createdAt)) }, { label: 'Id', value: <span class="mono">{workspace.id}</span> }]} />
        </Card>
        <Card class="danger-zone" title="Delete workspace" description="This can’t be undone.">
          <form method="post" action={`${href}/delete`} class="stack">
            <Callout tone="bad" title="What is lost">
              The workspace and everything in it: every module’s data, files, keys, members and settings. People who were in it keep their accounts.
            </Callout>
            <Field id="ws-confirm" label={<>Type <span class="mono">{workspace.slug}</span> to confirm</>} error={errors.confirm}>
              <Input id="ws-confirm" name="confirm" value={forms.deleteConfirm} autocomplete="off" spellcheck={false} required invalid={!!errors.confirm} />
            </Field>
            <div>
              <Button type="submit" variant="danger-solid" icon="trash">
                Delete workspace
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
