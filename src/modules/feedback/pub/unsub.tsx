/** Unsubscribe pages. A link in a mail opens a confirm page; the button (or a mail client's one-click request) posts. */
import type { Env } from '../../../env';
import { readAdminUnsubToken, readSubscriberToken } from '../notify';
import { readUnsubscribeToken } from '../people';
import { Shell, type Req } from './kit';

export type UnsubTarget = { kind: 'person'; org: string; id: string } | { kind: 'admin'; org: string; email: string } | { kind: 'subscriber'; org: string; id: string; token: string };

export async function readUnsubTarget(env: Env, t?: string | null, a?: string | null, s?: string | null): Promise<UnsubTarget | null> {
  if (t) {
    const p = await readUnsubscribeToken(env, t);
    if (p) return { kind: 'person', org: p.o, id: p.p };
  }
  if (a) {
    const m = await readAdminUnsubToken(env, a);
    if (m) return { kind: 'admin', org: m.o, email: m.e };
  }
  if (s) {
    const m = await readSubscriberToken(env, s);
    if (m) return { kind: 'subscriber', org: m.o, id: m.s, token: s };
  }
  return null;
}

export function unsubscribePage(r: Req, target: UnsubTarget | null, done: boolean) {
  const { portal } = r;
  const here = `/feedback/${portal.slug}/unsubscribe`;
  const action = target?.kind === 'subscriber' ? `/changelog/${portal.slug}/unsubscribe` : here;
  const field = target?.kind === 'admin' ? 'a' : target?.kind === 'subscriber' ? 's' : 't';
  const value = target?.kind === 'subscriber' ? target.token : (r.c.req.query(field) ?? '');
  return (
    <Shell r={r} title="Unsubscribe" path={here} noindex narrow>
      <h1 class="fb-title">Unsubscribe</h1>
      {!target ? (
        <div class="fb-card">
          <p>This link is not valid any more. It may be incomplete or too old.</p>
          <p class="fb-hint">If you still get email you do not want, use the unsubscribe link in the latest message.</p>
        </div>
      ) : done ? (
        <div class="fb-card" role="status">
          <p>You are unsubscribed. We will not send you any more of these emails.</p>
          <a class="fb-btn ghost" href={`/feedback/${portal.slug}`}>
            Back to {portal.name}
          </a>
        </div>
      ) : (
        <form class="fb-form fb-card" method="post" action={action}>
          <input type="hidden" name={field} value={value} />
          <p>
            Stop emails from <strong>{portal.name}</strong>?
          </p>
          <div class="fb-actions">
            <button class="fb-btn" type="submit">
              Unsubscribe
            </button>
            <a class="fb-btn ghost" href={`/feedback/${portal.slug}`}>
              Keep them
            </a>
          </div>
        </form>
      )}
    </Shell>
  );
}
