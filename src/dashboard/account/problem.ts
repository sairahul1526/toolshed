/**
 * Turns a refusal from the account services into a message placed next to the right field.
 * Only the stable error codes are matched; anything else is a bug and is thrown on.
 */
import { AppError } from '../../core/errors';

export type Section = 'name' | 'username' | 'email' | 'delete' | 'password' | 'two-step' | 'passkeys' | 'sessions';

export interface Problem {
  section: Section;
  /** The form field the message belongs under. Without one it is shown at the top of the section. */
  field?: string;
  message: string;
  /** True when the refusal is "sign in again": the section then offers a way to do it. */
  signIn: boolean;
  status: number;
}

/** What the person had typed, so a refused form comes back filled in. Never a password or a code. */
export interface Kept {
  name?: string;
  username?: string;
  email?: string;
  confirm?: string;
  passkeyName?: string;
  passkeyId?: string;
}

const FIELD_BY_CODE: Record<string, string> = {
  'auth.email_same': 'email',
  'auth.code_wrong': 'code',
  'auth.code_expired': 'code',
  'auth.code_used': 'code',
  'auth.code_limited': 'code',
  'auth.email_taken': 'code',
  'auth.password_weak': 'password',
  'auth.password_too_long': 'password',
  'auth.password_wrong': 'current',
  'auth.two_step_wrong': 'code',
  'auth.two_step_locked': 'code',
  'auth.username_taken': 'username',
  'auth.username_needs_password': 'username',
};

/** Where a message with no field of its own goes, by section: the one field a stranger could be guessing at. */
const RATE_LIMIT_FIELD: Partial<Record<Section, string>> = { email: 'email', 'two-step': 'current' };

/** The problem to show for `err`, or null when it is not an expected refusal and must be thrown on. */
export function toProblem(section: Section, err: unknown): Problem | null {
  if (!(err instanceof AppError)) return null;
  const signIn = err.code === 'auth.sign_in_again';
  if (err.code === 'validation_failed') {
    const [field, message] = Object.entries(err.fields ?? {})[0] ?? ['_', err.message];
    return { section, field: field === '_' ? undefined : field, message, signIn: false, status: 422 };
  }
  if (err.code === 'rate_limited') return { section, field: RATE_LIMIT_FIELD[section], message: err.message, signIn: false, status: 429 };
  if (!err.code.startsWith('auth.') || err.code === 'auth.session_not_found') return null;
  return { section, field: FIELD_BY_CODE[err.code], message: err.message, signIn, status: err.status };
}
