/**
 * The account, workspace and admin actions other parts of the app call. Each function checks for
 * itself who is asking and what they may do; a screen that calls one cannot skip a rule by
 * forgetting a check. Errors are the stable `auth.*` codes from `errors.ts`.
 */
export * from './service/actor';
export * from './service/account';
export * from './service/two-step';
export * from './service/workspaces';
export * from './service/roles';
export * from './service/members';
export * from './service/invites';
export * from './service/email-change';
export * from './service/sessions';
export * from './service/passkeys';
export * from './service/admin';
