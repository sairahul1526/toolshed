import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { devUi } from '../../src/ui/dev';
import { ErrorPage } from '../../src/ui/error-page';
import { PublicButton, PublicCard, PublicField, PublicInput, PublicPage } from '../../src/ui/public';
import { Icon, EmptyState, resolveIcon, Button, Callout, Field, Input, Pagination, Pill, Segmented, Stat, Table, BarChart, LineChart, Sparkline, Avatar } from '../../src/ui';

const html = (node: unknown) => String(node);

describe('components', () => {
  it('escapes user text', () => {
    const out = html(<Stat label={'<img src=x onerror=1>'} value="1" />);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
  it('Button renders variants and busy state', () => {
    expect(html(<Button variant="primary">Go</Button>)).toContain('btn');
    expect(html(<Button disabled>Go</Button>)).toContain('disabled');
  });
  it('Field wires label, hint and error to the input', () => {
    const out = html(
      <Field id="a" label="Email" hint="Hint" error="Bad">
        <Input id="a" name="a" invalid />
      </Field>,
    );
    expect(out).toContain('for="a"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('Bad');
  });
  it('Table keeps data labels for the stacked layout and shows empty state', () => {
    const out = html(<Table caption="T" columns={[{ key: 'a', label: 'Name' }]} rows={[{ a: 'x' }]} />);
    expect(out).toContain('data-label="Name"');
    const empty = html(<Table caption="T" columns={[{ key: 'a', label: 'Name' }]} rows={[]} empty={<p>Nothing</p>} />);
    expect(empty).toContain('Nothing');
  });
  it('Pagination hides itself for one page', () => {
    expect(html(<Pagination page={1} pageSize={25} total={10} href={(p) => `?p=${p}`} />)).not.toContain('?p=2');
    expect(html(<Pagination page={1} pageSize={25} total={60} href={(p) => `?p=${p}`} />)).toContain('?p=2');
  });
  it('charts include a hidden data table', () => {
    expect(html(<BarChart title="B" data={[{ label: 'a', value: 3 }]} />)).toContain('sr-only');
    expect(html(<LineChart title="L" labels={['a', 'b']} series={[{ label: 's', values: [1, 2] }]} />)).toContain('<svg');
    expect(html(<Sparkline values={[]} label="none" />)).toContain('none');
    expect(html(<BarChart title="B" data={[]} />)).toBeTruthy();
  });
  it('Pill, Callout, Avatar, Segmented render', () => {
    expect(html(<Pill tone="good">Live</Pill>)).toContain('Live');
    expect(html(<Callout tone="warn" title="T">Body</Callout>)).toContain('Body');
    expect(html(<Avatar name="X" />)).toContain('X');
    expect(html(<Segmented name="r" label="R" value="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)).toContain('type="radio"');
  });
});

describe('icons and field action', () => {
  it('resolves aliases and rejects unknown names', () => {
    expect(resolveIcon('sparkles')).toBe('spark');
    expect(resolveIcon('search')).toBe('search');
    expect(resolveIcon('nope')).toBeNull();
    expect(resolveIcon('toString')).toBeNull();
  });
  it('an unknown icon draws nothing and EmptyState falls back', () => {
    expect(String(<Icon name={'nope' as never} />)).toBe('');
    expect(String(<EmptyState icon="nope" title="T" />)).toContain('#i-layers');
  });
  it('Field action wraps the control and button together', () => {
    const html = String(<Field id="x" label="X" hint="h" action={<Button>Go</Button>}><Input id="x" name="x" /></Field>);
    expect(html).toContain('field-action');
    expect(html.indexOf('<button')).toBeGreaterThan(html.indexOf('<input'));
    expect(html.indexOf('class="hint"')).toBeGreaterThan(html.indexOf('<button'));
  });
});

describe('pages', () => {
  it('ErrorPage shows a headline and the request id', () => {
    const out = html(<ErrorPage status={404} code="not_found" message="Gone" requestId="req-1" signedIn={false} />);
    expect(out).toContain('Page not found');
    expect(out).toContain('req-1');
    expect(out).toContain('/assets/theme.js');
  });
  it('PublicPage uses the small stylesheet, no dashboard styles or scripts', () => {
    const out = html(
      <PublicPage title="Contact" brand="Northwind">
        <PublicCard>
          <PublicField id="n" label="Name">
            <PublicInput id="n" />
          </PublicField>
          <PublicButton type="submit">Send</PublicButton>
        </PublicCard>
      </PublicPage>,
    );
    expect(out).toContain('/assets/public.css');
    expect(out).not.toContain('/assets/toolshed.css');
    expect(out).not.toContain('/assets/app.js');
    expect(out).toContain('noindex');
    expect(out).toContain('pub-powered');
  });
  it('PublicPage can hide the credit', () => {
    const out = html(<PublicPage title="x" appearance={{ mode: 'system', accent: 'lime', preset: 'warm', powered: false }}>hi</PublicPage>);
    expect(out).not.toContain('pub-powered');
    expect(out).toContain('data-preset="warm"');
  });
});

describe('dev gallery', () => {
  const app = new Hono();
  app.route('/dev/ui', devUi);
  for (const path of ['/dev/ui', '/dev/ui?data=worst&accent=violet&theme=dark', '/dev/ui/auth', '/dev/ui/auth?state=code', '/dev/ui/public?preset=dusk', '/dev/ui/error?status=500']) {
    it(`renders ${path}`, async () => {
      const res = await app.request(`http://x.example.com${path}`);
      expect(res.status).toBe(path.includes('status=500') ? 500 : 200);
      const body = await res.text();
      expect(body).toMatch(/^<!doctype html>/i);
      expect(body).not.toMatch(/\son[a-z]+=/);
    });
  }
});
