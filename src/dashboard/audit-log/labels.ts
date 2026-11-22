/**
 * Plain-English text for the action codes other parts of Toolshed write (`<thing>.<verb>`).
 * Anything not listed here still shows: the raw code stands in for the sentence.
 */

type Label = string | ((target: string | null) => string);

const capitalise = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** The id of a module is its name in lower case, so it reads fine as "Links". */
const moduleLabel = (verb: string): Label => (target) => (target ? `${verb} ${capitalise(target)}` : `${verb} a module`);

const ACTIONS: Record<string, Label> = {
  'user.signed_in': 'Signed in',
  'user.signed_out': 'Signed out',
  'user.sign_in_paused': 'Sign-in paused after too many wrong tries',
  'password.removed': 'Removed a password',
  'passkey.added': 'Added a passkey',
  'two_step.turned_on': 'Turned on two-step sign-in',
  'two_step.turned_off': 'Turned off two-step sign-in',
  'two_step.codes_regenerated': 'Made new backup codes',
  'username.changed': 'Changed a username',
  'api_key.created': 'Made an API key',
  'api_key.renamed': 'Renamed an API key',
  'api_key.revoked': 'Revoked API keys',
  'api_key.rotated': 'Replaced an API key',
  'api_key.role_lowered': 'Lowered the access of API keys',
  'service_account.created': 'Made a service account',
  'service_account.updated': 'Changed a service account',
  'service_account.deleted': 'Deleted a service account',
  'signing_key.created': 'Made a signing key',
  'email.sender_changed': 'Changed the email sender',
  'email.suppression_removed': 'Allowed email to an address again',
  'email.test_sent': 'Sent a test email',
  'export.requested': 'Asked for a workspace export',
  'export.completed': 'A workspace export finished',
  'export.downloaded': 'Downloaded a workspace export',
  'audit.retention_changed': 'Changed how long the audit log is kept',
  'audit.exported': 'Exported the audit log',
  'member.invited': 'Invited a member',
  'member.removed': 'Removed a member',
  'member.role_changed': 'Changed a member’s role',
  'invite.revoked': 'Cancelled an invite',
  'module.enabled': moduleLabel('Turned on'),
  'module.disabled': moduleLabel('Turned off'),
  'workspace.renamed': 'Renamed the workspace',
  'appearance.changed': 'Changed the look of the workspace',
};

const CATEGORIES: Record<string, string> = {
  user: 'Sign-in',
  password: 'Sign-in',
  passkey: 'Sign-in',
  two_step: 'Sign-in',
  username: 'Sign-in',
  api_key: 'API keys',
  service_account: 'API keys',
  signing_key: 'API keys',
  email: 'Email',
  export: 'Exports',
  audit: 'Audit log',
  member: 'Members',
  invite: 'Members',
  module: 'Modules',
  workspace: 'Workspace',
  appearance: 'Workspace',
};

/** "api_key" -> "Api key". For codes nobody has described yet. */
export function humanise(code: string): string {
  return capitalise(code.replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim());
}

/** The first part of a code, which groups the filter menu. */
export function categoryOf(action: string): string {
  const prefix = action.split('.')[0] ?? action;
  return CATEGORIES[prefix] ?? humanise(prefix);
}

/** The sentence for one entry. `known` is false when it is only the raw code. */
export function describeAction(action: string, target: string | null = null): { text: string; known: boolean } {
  const label = ACTIONS[action];
  if (label === undefined) return { text: action, known: false };
  return { text: typeof label === 'function' ? label(target) : label, known: true };
}

/** The name in the action menu, which has no single target to put in a sentence. */
export function actionMenuName(action: string): string {
  const { text, known } = describeAction(action);
  return known ? text : action;
}
