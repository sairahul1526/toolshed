/** The address an endpoint sends to: public, https, and never this install itself. */
import { z } from 'zod';
import type { Env } from '../../env';
import { assertPublicUrl } from '../net';

/** The host (and port) of `APP_URL`, or null when it is not set or not an address. */
function ownHost(env: Env): string | null {
  const configured = env.APP_URL?.trim();
  if (!configured) return null;
  try {
    return new URL(configured).host.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * True when the address is this install. An event that sent a webhook to its own install could
 * raise another event, and so on without end. The check is on the text of the host: nothing is
 * looked up in DNS, so a different name that points here is not caught.
 */
export function pointsAtThisInstall(env: Env, address: string): boolean {
  const own = ownHost(env);
  if (!own) return false;
  try {
    return new URL(address).host.toLowerCase().replace(/\.$/, '') === own;
  } catch {
    return false;
  }
}

export function endpointUrl(env: Env) {
  return z
    .string('Enter the address to send events to.')
    .trim()
    .max(2000, 'Keep the address under 2,000 characters.')
    .superRefine((value, ctx) => {
      let parsed: URL | null = null;
      try {
        parsed = assertPublicUrl(value);
      } catch {
        // The message below says it for every kind of refusal.
      }
      if (!parsed || parsed.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: 'Enter a public address that starts with https://. Local, private and plain http addresses can’t be used.' });
      } else if (pointsAtThisInstall(env, value)) {
        ctx.addIssue({ code: 'custom', message: 'This address is this Toolshed install, so events would send themselves in a loop. Enter the address of another service.' });
      }
    });
}
