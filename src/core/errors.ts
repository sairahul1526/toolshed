/**
 * Stable error codes with plain messages.
 *
 * Every error the app returns on purpose is an AppError with a code from this file (or from a
 * module's own `defineErrors`). Codes never change once released; messages may be reworded.
 * API responses look like: { "code": "not_found", "message": "…", "requestId": "…", "fields": {…} }
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import type { AppEnv } from '../env';

export type FieldErrors = Record<string, string>;

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly fields?: FieldErrors,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

interface ErrorSpec {
  status: number;
  message: string;
}

const registry = new Map<string, ErrorSpec>();

function register<const T extends Record<string, ErrorSpec>>(prefix: string, specs: T) {
  const out = {} as { [K in keyof T]: (message?: string, fields?: FieldErrors) => AppError };
  for (const key of Object.keys(specs) as (keyof T & string)[]) {
    const spec = specs[key]!;
    const code = prefix ? `${prefix}.${key}` : key;
    if (registry.has(code)) throw new Error(`Error code registered twice: ${code}`);
    registry.set(code, spec);
    out[key] = (message, fields) => new AppError(code, spec.status, message ?? spec.message, fields);
  }
  return out;
}

/** Core error codes. Call as `errors.not_found()` or `errors.not_found('No link with that name.')`. */
export const errors = register('', {
  bad_request: { status: 400, message: 'That request isn’t valid. Check it and try again.' },
  validation_failed: { status: 422, message: 'Some fields need fixing.' },
  unauthorized: { status: 401, message: 'Sign in to continue.' },
  forbidden: { status: 403, message: 'You don’t have access to that. Ask a workspace admin.' },
  not_found: { status: 404, message: 'We couldn’t find that. It may have been moved or deleted.' },
  method_not_allowed: { status: 405, message: 'That action isn’t supported here.' },
  conflict: { status: 409, message: 'That clashes with something that already exists.' },
  too_large: { status: 413, message: 'That’s too large to accept.' },
  rate_limited: { status: 429, message: 'Too many tries. Wait a moment, then try again.' },
  module_off: { status: 404, message: 'That module is turned off for this workspace.' },
  needs_setup: { status: 409, message: 'This needs one more setup step before it can run.' },
  internal: { status: 500, message: 'Something went wrong on our side. Try again.' },
});

/**
 * Register a module's own codes. They are prefixed with the module id:
 * `const linkErrors = defineErrors('links', { slug_taken: { status: 409, message: '…' } })`
 * gives the code `links.slug_taken`.
 */
export function defineErrors<const T extends Record<string, ErrorSpec>>(moduleId: string, specs: T) {
  return register(moduleId, specs);
}

/** Every registered code, for the docs page and tests. */
export function listErrorCodes(): { code: string; status: number; message: string }[] {
  return [...registry.entries()].map(([code, s]) => ({ code, ...s })).sort((a, b) => a.code.localeCompare(b.code));
}

/** Validate input with a Zod schema. Throws `validation_failed` with one message per field. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: FieldErrors = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_';
    if (!(path in fields)) fields[path] = issue.message;
  }
  throw errors.validation_failed(undefined, fields);
}

/** Read a JSON body. Throws `bad_request` when it is missing or not an object. */
export async function readJson(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.bad_request('Send a JSON body.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw errors.bad_request('Send a JSON object.');
  return body as Record<string, unknown>;
}

export function wantsJson(c: Context): boolean {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) return true;
  const accept = c.req.header('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return errors.internal();
}

export function errorBody(err: AppError, requestId: string) {
  return { code: err.code, message: err.message, requestId, ...(err.fields ? { fields: err.fields } : {}) };
}

/** JSON error response. HTML error pages are rendered in app.ts with the UI kit. */
export function jsonError(c: Context<AppEnv>, err: AppError): Response {
  for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
  return c.json(errorBody(err, c.get('requestId')), err.status as ContentfulStatusCode);
}
