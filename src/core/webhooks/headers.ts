/** Custom headers an endpoint may add to every request. */
import { z } from 'zod';
import { MAX_HEADERS } from './types';

/** Names a workspace may not set: ours (signing, content), and ones that change how a request is routed or framed. */
const BLOCKED = new Set([
  'host', 'content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
  'keep-alive', 'expect', 'user-agent', 'cookie', 'set-cookie', 'via', 'forwarded', 'origin', 'referer',
]);
const BLOCKED_PREFIXES = ['webhook-', 'cf-', 'sec-', 'proxy-', 'x-forwarded-', 'x-real-'];

const NAME = /^[A-Za-z0-9-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// `new Headers()` throws on anything above U+00FF, so it is refused here rather than failing every send.
const OUTSIDE_LATIN1 = /[^\u0000-\u00ff]/;

function blocked(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED.has(lower) || BLOCKED_PREFIXES.some((p) => lower.startsWith(p));
}

export const headersField = z.record(z.string(), z.string('Header values must be text.')).superRefine((headers, ctx) => {
  const names = Object.keys(headers);
  if (names.length > MAX_HEADERS) ctx.addIssue({ code: 'custom', message: `Add up to ${MAX_HEADERS} headers.` });
  const seen = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!NAME.test(name)) ctx.addIssue({ code: 'custom', path: [name], message: 'Use letters, numbers and dashes only, up to 64 characters.' });
    else if (blocked(name)) ctx.addIssue({ code: 'custom', path: [name], message: 'We set this header ourselves, so it can’t be changed.' });
    else if (seen.has(lower)) ctx.addIssue({ code: 'custom', path: [name], message: 'This header is listed twice.' });
    seen.add(lower);
    const value = headers[name] ?? '';
    if (OUTSIDE_LATIN1.test(value)) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'Header values can’t contain emoji or letters outside the Latin set, such as Chinese or Arabic. Use plain letters, numbers and punctuation.' });
    } else if (value.length === 0 || value.length > 1024 || CONTROL.test(value)) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'Use a value of 1 to 1,024 characters on a single line.' });
    }
  }
});
