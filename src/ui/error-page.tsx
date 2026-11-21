/**
 * The page people see for 404s and other errors outside the API.
 * Plain words, a way out, and the reference to quote when asking for help.
 */
import { LinkButton } from './components/buttons';
import { Icon } from './components/icon';
import { AuthLayout } from './layout';

export interface ErrorPageProps {
  status: number;
  code: string;
  message: string;
  requestId: string;
  signedIn: boolean;
}

function headline(status: number): { title: string; icon: string } {
  if (status === 404) return { title: 'Page not found', icon: 'search' };
  if (status === 403) return { title: 'No access', icon: 'lock' };
  if (status === 401) return { title: 'Sign in to continue', icon: 'lock' };
  if (status === 429) return { title: 'Too many requests', icon: 'clock' };
  if (status >= 500) return { title: 'Something went wrong', icon: 'alert' };
  return { title: 'That did not work', icon: 'alert' };
}

export function ErrorPage({ status, code, message, requestId, signedIn }: ErrorPageProps) {
  const { title, icon } = headline(status);
  return (
    <AuthLayout title={title}>
      <section class="card error-card" aria-labelledby="error-title">
        <span class="error-icon">
          <Icon name={icon} />
        </span>
        <h1 id="error-title">{title}</h1>
        <p class="sub">{message}</p>
        <div class="form">
          <LinkButton variant="primary" size="block" href={signedIn ? '/app' : '/'}>
            {signedIn ? 'Back to overview' : 'Go to the start page'}
          </LinkButton>
          <p class="err-code">
            Error {code} · Reference {requestId}
          </p>
        </div>
      </section>
    </AuthLayout>
  );
}
