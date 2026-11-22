import type { Env } from '../../env';
import { getModuleSettings, setModuleSettings } from '../../core/registry';

export interface MailSettings extends Record<string, unknown> {
  /** Shown in every email footer. Most countries require a real postal address. */
  postalAddress: string;
  /** Tracking is off until a person turns it on for a broadcast. These are the defaults for new ones. */
  trackOpens: boolean;
  trackClicks: boolean;
  /** The public address of the install, remembered so jobs can build links without a request. */
  baseUrl: string;
  /** Set once the three-step first run is finished or skipped. */
  firstRunDone: boolean;
}

const DEFAULTS: MailSettings = { postalAddress: '', trackOpens: false, trackClicks: false, baseUrl: '', firstRunDone: false };

export function getMailSettings(env: Env, orgId: string): Promise<MailSettings> {
  return getModuleSettings(env, orgId, 'mail', DEFAULTS);
}

export async function saveMailSettings(env: Env, orgId: string, patch: Partial<MailSettings>): Promise<MailSettings> {
  const next = { ...(await getMailSettings(env, orgId)), ...patch };
  await setModuleSettings(env, orgId, 'mail', next);
  return next;
}

/** The address links in emails start with. Jobs have no request, so fall back to what a request saved. */
export async function linkBase(env: Env, orgId: string): Promise<string> {
  const configured = env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return (await getMailSettings(env, orgId)).baseUrl.replace(/\/+$/, '');
}
