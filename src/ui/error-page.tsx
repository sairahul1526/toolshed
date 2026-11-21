/**
 * The page people see for 404s and other errors outside the API.
 * PLACEHOLDER markup; the UI kit replaces it. Keep the props.
 */
export interface ErrorPageProps {
  status: number;
  code: string;
  message: string;
  requestId: string;
  signedIn: boolean;
}

export function ErrorPage(props: ErrorPageProps) {
  const title = props.status === 404 ? 'Page not found' : props.status === 403 ? 'No access' : 'Something went wrong';
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>
        <main>
          <h1>{title}</h1>
          <p>{props.message}</p>
          <p>
            <a href={props.signedIn ? '/app' : '/'}>{props.signedIn ? 'Back to overview' : 'Go to the start page'}</a>
          </p>
          <p>
            <small>
              Error {props.code} · Reference {props.requestId}
            </small>
          </p>
        </main>
      </body>
    </html>
  );
}
