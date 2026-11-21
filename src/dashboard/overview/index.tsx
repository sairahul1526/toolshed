/**
 * Overview, the first screen after sign-in (/app).
 * A small starting page built from the UI kit; the real overview replaces the body.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { Callout, EmptyState, LinkButton, PageHeader, renderPage } from '../../ui';

const screen = new Hono<AppEnv>();

screen.get('/', (c) => {
  const org = c.get('org');
  return renderPage(
    c,
    { title: 'Overview', crumbs: [{ label: 'Overview' }] },
    <>
      <PageHeader title="Overview" soft={org?.name} description="What is happening across your workspace." />
      <EmptyState
        icon="layers"
        title="Nothing to show yet"
        body="Turn on a module to start collecting numbers here."
        actions={
          <LinkButton variant="primary" href="/app/modules">
            Browse modules
          </LinkButton>
        }
      />
      <Callout tone="info" title="You are signed in">
        Use the sidebar to move around. Press Ctrl K or Cmd K to jump to any page.
      </Callout>
    </>,
  );
});

export default screen;
