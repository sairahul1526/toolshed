import { defineErrors } from '../../core/errors';

export const linkErrors = defineErrors('links', {
  not_found: { status: 404, message: 'We couldn’t find that link. It may have been deleted.' },
  bio_not_found: { status: 404, message: 'We couldn’t find that bio page. It may have been deleted.' },
  code_taken: { status: 409, message: 'That short code is already in use. Pick another one.' },
  code_invalid: { status: 422, message: 'Short codes use 3 to 64 letters, numbers, dashes and underscores.' },
  code_reserved: { status: 422, message: 'That short code is reserved for the app. Pick another one.' },
  url_invalid: { status: 422, message: 'Enter a full web address that starts with http:// or https://.' },
  domain_blocked: { status: 422, message: 'Links to that website aren’t allowed in this workspace.' },
  folder_not_found: { status: 404, message: 'We couldn’t find that folder.' },
  block_not_found: { status: 404, message: 'We couldn’t find that block.' },
  password_wrong: { status: 403, message: 'That password isn’t right.' },
  import_too_large: { status: 413, message: 'That file has too many rows. Import up to 1,000 links at a time.' },
  bulk_too_large: { status: 413, message: 'Send up to 100 links at a time.' },
  report_invalid: { status: 422, message: 'Tell us what’s wrong with this link.' },
});
