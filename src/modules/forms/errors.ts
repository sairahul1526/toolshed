import { defineErrors } from '../../core/errors';

/** Codes are `forms.<key>`. They never change once released; messages may be reworded. */
export const formErrors = defineErrors('forms', {
  not_found: { status: 404, message: 'We couldn’t find that form.' },
  slug_taken: { status: 409, message: 'That address is already used by another form. Pick a different one.' },
  invalid_definition: { status: 422, message: 'The form has a problem that needs fixing before it can be saved.' },
  nothing_to_publish: { status: 422, message: 'Add at least one question before you publish.' },
  stale_draft: { status: 409, message: 'This form was changed somewhere else. Reload to see the latest version.' },
  version_not_found: { status: 404, message: 'We couldn’t find that version.' },
  closed: { status: 403, message: 'This form is not taking responses.' },
  full: { status: 403, message: 'This form has reached its limit of responses.' },
  password_needed: { status: 401, message: 'Enter the password to open this form.' },
  bad_password: { status: 403, message: 'That password isn’t right.' },
  answers_invalid: { status: 422, message: 'Some answers need fixing.' },
  link_expired: { status: 422, message: 'This page was open for too long. Your answers are kept: send them again.' },
  needs_token: { status: 403, message: 'This form can only be sent from its own page. Open the form and send it there.' },
  too_many: { status: 429, message: 'Too many responses from here. Try again in a few minutes.' },
  file_rejected: { status: 422, message: 'That file can’t be uploaded.' },
  file_too_large: { status: 413, message: 'That file is too large.' },
  submission_not_found: { status: 404, message: 'We couldn’t find that response.' },
  import_invalid: { status: 422, message: 'That CSV can’t be imported.' },
  definition_too_large: { status: 413, message: 'This form is too big. Split it into two forms.' },
});
