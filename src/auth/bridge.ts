/**
 * One way to call Better Auth from our own code. Its answers (which can hold session tokens) never
 * go to the browser: callers get a small summary and the cookies to pass on, nothing else.
 */
export interface AuthReply<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  /** Better Auth's error code, for example `INVALID_CODE`. Null on success. */
  code: string | null;
  data: T | null;
  /** `Set-Cookie` values to copy onto our response. */
  cookies: string[];
}

interface ErrorLike {
  statusCode?: number;
  status?: number | string;
  body?: { code?: string };
  headers?: Headers;
}

export async function callAuth<T = Record<string, unknown>>(run: () => Promise<Response>): Promise<AuthReply<T>> {
  let res: Response;
  try {
    res = await run();
  } catch (err) {
    // Better Auth normally turns its own errors into responses. Anything else is a real fault.
    const e = err as ErrorLike;
    if (!e || typeof e.statusCode !== 'number') throw err;
    return { ok: false, status: e.statusCode, code: e.body?.code ?? null, data: null, cookies: e.headers?.getSetCookie() ?? [] };
  }
  const cookies = res.headers.getSetCookie();
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) return { ok: true, status: res.status, code: null, data: (body ?? {}) as T, cookies };
  const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : null;
  return { ok: false, status: res.status, code, data: null, cookies };
}
