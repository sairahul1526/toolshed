/** Pages strangers see: signup, confirm, unsubscribe and the public archive. No scripts, no inline styles. */
import { raw } from 'hono/html';
import { PublicButton, PublicCard, PublicField, PublicInput, PublicPage, formatDate, type Appearance } from '../../ui';
import type { ArchiveIssue } from './archive';
import type { List } from './types';

const STYLES = ['/m/mail/mail-public.css'];

export function NoticePage({ title, body, appearance }: { title: string; body: string; appearance: Appearance }) {
  return (
    <PublicPage title={title} appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>{title}</h1>
        <p>{body}</p>
      </PublicCard>
    </PublicPage>
  );
}

export interface SignupProps {
  list: List;
  appearance: Appearance;
  embed?: boolean;
  error?: string;
  email?: string;
  name?: string;
  hasArchive?: boolean;
  /** Fields the owner asked for; the signup form shows a name box only. */
  brand?: string;
}

export function SignupPage({ list, appearance, embed, error, email, name, hasArchive, brand }: SignupProps) {
  const action = `/n/${list.slug}/subscribe${embed ? '?embed=1' : ''}`;
  return (
    <PublicPage title={list.name} appearance={appearance} styles={STYLES} {...(brand && !embed ? { brand } : {})} indexable={!embed} description={list.description || `Subscribe to ${list.name}`}>
      <PublicCard class={embed ? 'ml-embed' : undefined}>
        <h1>{list.name}</h1>
        {list.description ? <p>{list.description}</p> : null}
        <form method="post" action={action} class="ml-form" novalidate>
          <PublicField id="name" label="Name" optional>
            <PublicInput id="name" name="name" value={name ?? ''} autocomplete="name" maxlength={80} />
          </PublicField>
          <PublicField id="email" label="Email" {...(error ? { error } : {})}>
            <PublicInput id="email" name="email" type="email" value={email ?? ''} required autocomplete="email" inputmode="email" maxlength={254} invalid={!!error} describedBy={error ? 'email-error' : undefined} />
          </PublicField>
          <div class="ml-hp" aria-hidden="true">
            <label for="website">Leave this empty</label>
            <input id="website" name="website" type="text" tabindex={-1} autocomplete="off" />
          </div>
          <PublicButton type="submit" block>
            Subscribe
          </PublicButton>
        </form>
        <p class="ml-small">{list.double_opt_in ? 'We will send one email to confirm it is you. ' : ''}You can leave with one click at any time.</p>
        {hasArchive && !embed ? (
          <p class="ml-small">
            <a href={`/n/${list.slug}/archive`}>Read past issues</a>
          </p>
        ) : null}
      </PublicCard>
    </PublicPage>
  );
}

export function SignupDonePage({ list, appearance, embed }: { list: List; appearance: Appearance; embed?: boolean }) {
  const text = list.thanks_text.trim() || (list.double_opt_in ? 'Check your inbox. If the address is right, a confirmation link is on its way.' : 'You are subscribed. Thank you.');
  return (
    <PublicPage title="Thank you" appearance={appearance} styles={STYLES}>
      <PublicCard class={embed ? 'ml-embed' : undefined}>
        <h1>{list.double_opt_in ? 'Check your inbox' : 'You are subscribed'}</h1>
        <p>{text}</p>
      </PublicCard>
    </PublicPage>
  );
}

/** A confirmation link opens this page; the button does the work, so mail scanners that open links cannot subscribe anyone. */
export function ConfirmPage({ listName, token, appearance }: { listName: string; token: string; appearance: Appearance }) {
  return (
    <PublicPage title="Confirm your email" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>Confirm your subscription</h1>
        <p>Press the button to start getting {listName}.</p>
        <form method="post" action={`/n/confirm/${token}`}>
          <PublicButton type="submit" block>
            Yes, subscribe me
          </PublicButton>
        </form>
      </PublicCard>
    </PublicPage>
  );
}

export function ConfirmedPage({ listName, appearance }: { listName: string; appearance: Appearance }) {
  return (
    <PublicPage title="Subscribed" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>You are subscribed</h1>
        <p>Thank you. You will now get {listName}.</p>
      </PublicCard>
    </PublicPage>
  );
}

export function UnsubscribePage({ listName, token, appearance }: { listName: string; token: string; appearance: Appearance }) {
  return (
    <PublicPage title="Unsubscribe" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>Unsubscribe</h1>
        <p>Stop getting {listName}?</p>
        <form method="post" action={`/n/u/${token}`}>
          <PublicButton type="submit" block>
            Unsubscribe
          </PublicButton>
        </form>
      </PublicCard>
    </PublicPage>
  );
}

export function UnsubscribedPage({ listName, appearance }: { listName: string; appearance: Appearance }) {
  return (
    <PublicPage title="Unsubscribed" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>You are unsubscribed</h1>
        <p>You will not get any more of {listName}. It can take a few minutes for emails already in the queue to stop.</p>
      </PublicCard>
    </PublicPage>
  );
}

export function ArchiveIndexPage({ list, issues, appearance }: { list: List; issues: ArchiveIssue[]; appearance: Appearance }) {
  return (
    <PublicPage title={`${list.name} archive`} appearance={appearance} styles={STYLES} wide indexable description={`Past issues of ${list.name}`}>
      <PublicCard>
        <h1>{list.name}</h1>
        <p class="ml-small">
          <a href={`/n/${list.slug}`}>Subscribe</a> &middot; <a href={`/n/${list.slug}/rss.xml`}>RSS</a>
        </p>
        {issues.length === 0 ? (
          <p>No issues yet.</p>
        ) : (
          <ul class="ml-issues">
            {issues.map((i) => (
              <li>
                <a href={`/n/${list.slug}/archive/${i.slug}`}>{i.subject}</a>
                <span class="ml-small">{formatDate(i.sent_at)}</span>
                {i.summary ? <p>{i.summary}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </PublicCard>
    </PublicPage>
  );
}

export function ArchiveIssuePage({ list, issue, appearance }: { list: List; issue: { subject: string; html: string; sent_at: number }; appearance: Appearance }) {
  return (
    <PublicPage title={issue.subject} appearance={appearance} styles={STYLES} wide indexable>
      <PublicCard>
        <p class="ml-small">
          <a href={`/n/${list.slug}/archive`}>{list.name}</a> &middot; {formatDate(issue.sent_at)}
        </p>
        <h1>{issue.subject}</h1>
        <div class="ml-issue">{raw(issue.html)}</div>
        <p class="ml-small">
          <a href={`/n/${list.slug}`}>Subscribe to {list.name}</a>
        </p>
      </PublicCard>
    </PublicPage>
  );
}
