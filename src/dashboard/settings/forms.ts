/** Reading posted forms. The services validate every value again; this only picks the text out. */
import { AppError } from '../../core/errors';
import type { FieldErrors } from '../../core/errors';

export type Body = Record<string, string | File | (string | File)[]>;

/** The first text value sent under `name`, or an empty string. Files are never read. */
export function textField(body: Body, name: string): string {
  const value = body[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

/** Every text value sent under `name` (a group of checkboxes). */
export function listField(body: Body, name: string): string[] {
  const value = body[name];
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v): v is string => typeof v === 'string');
}

export interface Failure {
  fields: FieldErrors;
  message: string;
  status: 422 | 409;
}

/**
 * A refusal a form can show next to its fields: a failed check, or a name already taken. Anything
 * else (a wrong role, a missing row) is not the form's to explain, so it returns null.
 */
export function failureOf(err: unknown): Failure | null {
  if (!(err instanceof AppError)) return null;
  if (err.code === 'validation_failed') return { fields: err.fields ?? {}, message: err.message, status: 422 };
  if (err.code === 'auth.slug_taken') return { fields: { slug: err.message }, message: err.message, status: 409 };
  return null;
}

/** The first message for a field, including list items such as `events.2`. */
export function fieldError(fields: FieldErrors, name: string): string | undefined {
  const key = Object.keys(fields).find((k) => k === name || k.startsWith(`${name}.`));
  return key === undefined ? undefined : fields[key];
}
