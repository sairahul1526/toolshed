import { defineErrors } from '../../core/errors';

export const mailErrors = defineErrors('mail', {
  list_not_found: { status: 404, message: 'We couldn’t find that newsletter. It may have been deleted.' },
  slug_taken: { status: 409, message: 'That web address is taken. Choose another one.' },
  subscriber_not_found: { status: 404, message: 'We couldn’t find that subscriber.' },
  broadcast_not_found: { status: 404, message: 'We couldn’t find that email.' },
  not_editable: { status: 409, message: 'This email has already gone out or is sending, so it can’t be changed. Duplicate it to send a new version.' },
  not_sendable: { status: 409, message: 'This email can’t be sent yet. Fix the items in the checklist first.' },
  needs_consent: { status: 422, message: 'Confirm that these people agreed to get your emails before you import them.' },
  needs_sender: { status: 409, message: 'Email sending isn’t set up for this install yet. Open the Email screen to finish setup.' },
  sequence_full: { status: 409, message: 'A welcome sequence can have up to 10 emails. Remove one to add another.' },
  template_not_found: { status: 404, message: 'We couldn’t find that template.' },
  template_key_taken: { status: 409, message: 'A template with that key already exists. Choose another key.' },
  suppressed: { status: 422, message: 'This address can’t receive email: it unsubscribed, bounced or complained.' },
  capped: { status: 429, message: 'This install reached its hourly email limit. Try again in a few minutes.' },
  send_failed: { status: 502, message: 'The email couldn’t be sent. Check the Email screen for the reason.' },
  feed_failed: { status: 422, message: 'We couldn’t read that feed. Check the address and try again.' },
  bad_token: { status: 400, message: 'This link isn’t valid any more. Ask for a new one.' },
});
