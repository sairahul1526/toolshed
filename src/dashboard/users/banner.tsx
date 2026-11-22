/**
 * The strip shown above every page while the owner is signed in as someone else. The shell draws
 * it from `currentImpersonation(c)`; "Stop" posts to the route this screen owns, which works
 * for the person being impersonated because it sits outside the owner-only check.
 */
import { Button, Icon, formatDateTime } from '../../ui';
import type { Impersonation } from '../../auth/service';
import { BASE } from './data';

export function ImpersonationBanner({ session }: { session: Impersonation }) {
  return (
    <div class="banner" role="status">
      <Icon name="eye" />
      <span>
        You’re signed in as <b>{session.user.name || session.user.email}</b>. Every action is logged under your name. This ends by itself at {formatDateTime(session.expiresAt)}.
      </span>
      <span class="spacer" />
      <form method="post" action={`${BASE}/impersonation/stop`}>
        <Button type="submit" size="sm">
          Stop
        </Button>
      </form>
    </div>
  );
}
