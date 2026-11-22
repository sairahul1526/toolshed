/** The Devices tab: where this account is signed in, with a way to sign each one out. */
import { Button, Card, ConfirmButton, EmptyState, Icon, Pill, timeAgo } from '../../ui';
import { BASE, Notice, type View } from './view';

type SessionRow = View['data']['sessions'][number];

function describe(s: SessionRow): string {
  const what = [s.browser, s.os].filter(Boolean).join(' on ');
  return what || s.device;
}

function Row({ s, now, locked }: { s: SessionRow; now: number; locked: boolean }) {
  return (
    <li>
      <span class={s.current ? 'mod-icon ok' : 'mod-icon'}>
        <Icon name={s.kind === 'phone' ? 'phone' : 'laptop'} />
      </span>
      <span class="row-text">
        <b>{describe(s)}</b>
        <span>
          {s.ip ? `${s.ip} · ` : ''}
          {s.current ? 'Active now' : `Last active ${timeAgo(s.lastSeenAt, now)}`}
        </span>
      </span>
      {s.current ? <Pill tone="good">This device</Pill> : null}
      {s.impersonated ? <Pill tone="warn">Owner view</Pill> : null}
      {s.current ? null : (
        <form method="post" action={`${BASE}/sessions/${encodeURIComponent(s.id)}/revoke`}>
          <Button type="submit" size="sm" disabled={locked}>
            Sign out
          </Button>
        </form>
      )}
    </li>
  );
}

export function SessionsTab({ v }: { v: View }) {
  const { sessions, now, mode } = v.data;
  const others = sessions.filter((s) => !s.current).length;
  const locked = mode === 'impersonating';
  return (
    <Card
      ruled
      flush
      title="Where you are signed in"
      description="Sign out anything you do not recognise. It stops working straight away."
      footer={
        <form method="post" action={`${BASE}/sessions/revoke-others`}>
          {others === 0 || locked ? (
            <Button variant="danger" disabled>
              Sign out all other devices
            </Button>
          ) : (
            <ConfirmButton id="sign-out-others" title="Sign out all other devices?" body="Every device except this one is signed out and has to sign in again." confirmLabel="Sign out others">
              Sign out all other devices
            </ConfirmButton>
          )}
        </form>
      }
    >
      {v.problem?.section === 'sessions' ? (
        <div class="card-body">
          <Notice v={v} section="sessions" />
        </div>
      ) : null}
      {sessions.length === 0 ? (
        <EmptyState bare icon="laptop" title="No sessions found" body="This should not happen while you are signed in." />
      ) : (
        <ul class="rows">
          {sessions.map((s) => (
            <Row s={s} now={now} locked={locked} />
          ))}
        </ul>
      )}
    </Card>
  );
}
