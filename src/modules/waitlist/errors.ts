import { defineErrors } from '../../core/errors';

export const wlErrors = defineErrors('waitlist', {
  not_found: { status: 404, message: 'That waitlist does not exist.' },
  person_not_found: { status: 404, message: 'That person is not on this waitlist.' },
  slug_taken: { status: 409, message: 'That address is already used by another waitlist.' },
  closed: { status: 403, message: 'This waitlist is not taking signups right now.' },
  bad_email: { status: 400, message: 'Enter a valid email address.' },
  email_not_allowed: { status: 400, message: 'That email address cannot join this waitlist.' },
  too_fast: { status: 429, message: 'That was very quick. Wait a moment and try again.' },
  need_confirm_email: { status: 409, message: 'Confirm your email first.' },
  email_off: { status: 409, message: 'Email is not set up, so this cannot be sent.' },
  test_first: { status: 409, message: 'Send a test email with this exact content first.' },
  nothing_to_send: { status: 409, message: 'No one matches, so there is nothing to send.' },
  wrong_state: { status: 409, message: 'That cannot be done in the current state.' },
  bad_invite: { status: 404, message: 'That invite code is not valid.' },
  bad_import: { status: 400, message: 'The file could not be read as a list of signups.' },
});
