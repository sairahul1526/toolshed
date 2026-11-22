/** The public status page and the small pages around it (subscribe, confirm, unsubscribe). No third-party requests, no inline styles. */
import type { Child } from 'hono/jsx';
import { type Appearance } from '../../ui/appearance';
import { PublicButton, PublicCard, PublicPage } from '../../ui/public';
import { formatDateTime } from '../../ui/format';
import type { ComponentStatus, StatusBar, StatusComponent, StatusData, StatusIncident } from './pages';

const CSS = '/m/monitor/status.css';

const ICON: Record<ComponentStatus, string> = { operational: '✓', maintenance: '⚙', degraded: '!', partial: '!', major: '×' };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Bars({ bars, name }: { bars: StatusBar[]; name: string }) {
  return (
    <div class="st-bars" role="img" aria-label={`Daily uptime for ${name}, last ${bars.length} days`}>
      {bars.map((b) => (
        <span class={`st-bar ${b.level}`} title={`${b.day}: ${b.pct === null ? 'no data' : `${b.pct.toFixed(2)}% up`}`}></span>
      ))}
    </div>
  );
}

function Component({ c, days }: { c: StatusComponent; days: number }) {
  return (
    <li class="st-comp">
      <div class="st-comp-head">
        <span class="st-comp-name">{c.name}</span>
        <span class={`st-pill ${c.status}`}>{c.label}</span>
      </div>
      {c.description ? <p class="st-comp-desc">{c.description}</p> : null}
      {c.bars ? (
        <>
          <Bars bars={c.bars} name={c.name} />
          <div class="st-bars-foot">
            <span>{days} days ago</span>
            <span>{c.uptimePct === null ? 'No data yet' : `${c.uptimePct.toFixed(c.uptimePct === 100 ? 0 : 2)}% uptime`}</span>
            <span>Today</span>
          </div>
        </>
      ) : null}
    </li>
  );
}

function Incident({ i }: { i: StatusIncident }) {
  return (
    <article class="st-incident" id={i.id}>
      <header>
        <h3>{i.title}</h3>
        <span class={`st-pill ${i.impact === 'critical' ? 'major' : i.impact === 'major' ? 'partial' : 'degraded'}`}>{cap(i.impact)} impact</span>
      </header>
      <ol class="st-updates">
        {i.updates.map((u) => (
          <li>
            <strong>{cap(u.status)}</strong>
            <span class="st-when">{formatDateTime(u.at)}</span>
            <p>{u.body}</p>
          </li>
        ))}
      </ol>
      {i.postmortem ? (
        <details class="st-post">
          <summary>Postmortem</summary>
          <p>{i.postmortem}</p>
        </details>
      ) : null}
    </article>
  );
}

export interface StatusPageProps {
  data: StatusData;
  appearance: Appearance;
  base: string;
  subscribeResult?: 'sent' | 'off' | null;
}

export function StatusPage({ data, appearance, base, subscribeResult }: StatusPageProps) {
  const { page } = data;
  const link = `${base}/status/${page.slug}`;
  return (
    <PublicPage title={page.title} appearance={{ ...appearance }} wide indexable={!page.hideFromSearch} description={page.description ?? data.overall.text} styles={[CSS, `/status/${page.slug}/custom.css`]}>
      <div class="st-head">
        <h1>{page.websiteUrl ? <a href={page.websiteUrl} rel="noopener">{page.title}</a> : page.title}</h1>
        {page.description ? <p>{page.description}</p> : null}
      </div>
      <div class={`st-banner ${data.overall.status}`} role="status">
        <span class="st-icon" aria-hidden="true">{ICON[data.overall.status]}</span>
        <span>{data.overall.text}</span>
      </div>

      {data.maintenance.length ? (
        <section class="st-section" aria-label="Maintenance">
          <h2>Scheduled maintenance</h2>
          {data.maintenance.map((m) => (
            <div class="st-maint">
              <strong>{m.title}</strong>
              <span class="st-when">{m.active ? 'In progress, until ' : ''}{m.active ? formatDateTime(m.end) : `${formatDateTime(m.start)} to ${formatDateTime(m.end)}`}</span>
              {m.body ? <p>{m.body}</p> : null}
            </div>
          ))}
        </section>
      ) : null}

      {data.active.length ? (
        <section class="st-section" aria-label="Open incidents">
          <h2>Open incidents</h2>
          {data.active.map((i) => <Incident i={i} />)}
        </section>
      ) : null}

      <section class="st-section" aria-label="Components">
        {data.loose.length ? <ul class="st-list">{data.loose.map((c) => <Component c={c} days={page.uptimeDays} />)}</ul> : null}
        {data.groups.map((g) => (
          <details class="st-group" open={!g.collapsed}>
            <summary>{g.name}</summary>
            <ul class="st-list">{g.components.map((c) => <Component c={c} days={page.uptimeDays} />)}</ul>
          </details>
        ))}
        {!data.loose.length && !data.groups.length ? <p class="st-empty">Nothing is listed on this page yet.</p> : null}
      </section>

      <section class="st-section" aria-label="Past incidents">
        <h2>Past incidents</h2>
        {data.past.length ? data.past.map((i) => <Incident i={i} />) : <p class="st-empty">No incidents in the last 90 days.</p>}
      </section>

      <footer class="st-foot">
        {page.allowSubscribe ? (
          <form class="st-sub" method="post" action={`/status/${page.slug}/subscribe`}>
            <label for="sub-email">Get updates by email</label>
            <div class="st-sub-row">
              <input class="pub-input" id="sub-email" name="email" type="email" required autocomplete="email" maxlength={254} placeholder="you@example.com" />
              <input class="st-hp" type="text" name="website" tabindex={-1} autocomplete="off" aria-hidden="true" />
              <button class="pub-btn" type="submit">Subscribe</button>
            </div>
            {subscribeResult === 'off' ? <span class="pub-error">Email isn’t set up on this site yet, so subscribing is off.</span> : null}
          </form>
        ) : null}
        <p class="st-links">
          <a href={`${link}/feed.rss`}>RSS</a> <a href={`${link}/feed.atom`}>Atom</a> <a href={`${link}/status.json`}>JSON</a>
        </p>
        <p class="st-updated">Updated {formatDateTime(data.generatedAt)}</p>
      </footer>
    </PublicPage>
  );
}

/** A plain one-card page: "Check your email", "You're subscribed", "Link expired". */
export function NoticePage({ title, body, appearance, slug, action, children }: { title: string; body: string; appearance: Appearance; slug?: string; action?: { href: string; label: string }; children?: Child }) {
  return (
    <PublicPage title={title} appearance={appearance} styles={[CSS]}>
      <PublicCard>
        <h1>{title}</h1>
        <p>{body}</p>
        {children}
        {action ? <PublicButton href={action.href}>{action.label}</PublicButton> : slug ? <PublicButton href={`/status/${slug}`} ghost>Back to the status page</PublicButton> : null}
      </PublicCard>
    </PublicPage>
  );
}

export function UnsubscribePage({ slug, token, title, appearance }: { slug: string; token: string; title: string; appearance: Appearance }) {
  return (
    <PublicPage title="Unsubscribe" appearance={appearance} styles={[CSS]}>
      <PublicCard>
        <h1>Unsubscribe</h1>
        <p>Stop email updates from {title}?</p>
        <form method="post" action={`/status/${slug}/unsubscribe/${token}`}>
          <PublicButton type="submit" block>Unsubscribe</PublicButton>
        </form>
      </PublicCard>
    </PublicPage>
  );
}
