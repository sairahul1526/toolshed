/** The JSON body of an event: `{ id, type, timestamp, workspace_id, subject, data }`. */
import { MAX_BODY_BYTES } from './types';

export interface EventBodyInput {
  id: string;
  type: string;
  at: number;
  orgId: string;
  subject: string | null;
  data: unknown;
}

const encoder = new TextEncoder();

/** Too big a body (over 256 KB) keeps its envelope and swaps `data` for `{ "truncated": true }`. */
export function buildBody(input: EventBodyInput): string {
  const envelope = (data: unknown) =>
    JSON.stringify({
      id: input.id,
      type: input.type,
      timestamp: new Date(input.at).toISOString(),
      workspace_id: input.orgId,
      subject: input.subject,
      data,
    });
  const body = envelope(input.data ?? {});
  return encoder.encode(body).byteLength > MAX_BODY_BYTES ? envelope({ truncated: true }) : body;
}
