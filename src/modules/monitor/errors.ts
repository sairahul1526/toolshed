import { defineErrors } from '../../core/errors';

export const monitorErrors = defineErrors('monitor', {
  url_not_allowed: { status: 422, message: 'That address can’t be checked. Use a public http or https address.' },
  slug_taken: { status: 409, message: 'That page address is taken. Pick another one.' },
  not_a_heartbeat: { status: 409, message: 'Only heartbeat monitors have a ping address.' },
  incident_resolved: { status: 409, message: 'This incident is already resolved. Reopen it by posting an update with another status.' },
  email_not_ready: { status: 409, message: 'Email isn’t set up yet, so subscribing by email is off. Use the RSS or Atom feed instead.' },
  channel_failed: { status: 502, message: 'The test message could not be delivered. Check the details and try again.' },
  import_empty: { status: 422, message: 'No monitors were found in that file.' },
  limit_reached: { status: 409, message: 'You’ve reached the limit for this workspace. Remove one first.' },
  already_subscribed: { status: 409, message: 'That address is already subscribed.' },
});
