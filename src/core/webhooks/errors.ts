import { defineErrors } from '../errors';

export const webhookErrors = defineErrors('webhooks', {
  session_required: { status: 403, message: 'Keys and tokens can’t read or replace a signing secret. Sign in to the dashboard to do that.' },
  too_many: { status: 409, message: 'This workspace has reached its limit of 20 webhook endpoints. Delete one you no longer use, then try again.' },
  endpoint_disabled: { status: 409, message: 'We stopped sending to this endpoint because it kept failing. Turn it back on first, then try again.' },
  delivery_pending: { status: 409, message: 'This delivery is still being tried. Wait until it succeeds or fails, then send it again.' },
});
