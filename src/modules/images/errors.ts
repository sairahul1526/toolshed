/** The module's own error codes. Codes never change once released; messages may be reworded. */
import { defineErrors } from '../../core/errors';

export const imageErrors = defineErrors('images', {
  slug_taken: { status: 409, message: 'Another template already uses that URL name. Pick a different one.' },
  not_published: { status: 404, message: 'This template has not been published yet. Open it and press Publish.' },
  signature_required: { status: 403, message: 'This image URL needs a signature. Copy the full URL from the template’s page.' },
  bad_signature: { status: 403, message: 'This image URL was changed after it was signed. Copy a fresh URL from the template’s page.' },
  link_expired: { status: 410, message: 'This image URL has expired. Make a new one from the template’s page.' },
  png_needs_bake: {
    status: 404,
    message: 'This PNG has not been made yet. Open the template, press Make PNG, and use the URL it gives you. PNG on first request needs server rendering, which is off for this workspace.',
  },
  server_png_off: {
    status: 409,
    message: 'Drawing PNG files on the server is off for this workspace. Ask for SVG, make the PNG in the browser from the template’s page, or turn on server PNG in Images settings (needs the Workers Paid plan).',
  },
  daily_cap: { status: 429, message: 'This workspace has made its limit of new images for today. Images already made keep working. The limit resets at midnight UTC.' },
  template_cap: { status: 429, message: 'This template has made its limit of new images. Images already made keep working.' },
  too_many_templates: { status: 409, message: 'This workspace has reached its limit of templates. Delete one you no longer use.' },
  bad_template: { status: 422, message: 'This template file is not valid. Export a template from Images and import that file.' },
  unsupported_file: { status: 415, message: 'That file type is not supported. Upload a PNG, JPEG, WebP or GIF picture, or a TrueType (.ttf) font.' },
  bad_font: { status: 422, message: 'This font file cannot be used.' },
  storage_full: { status: 409, message: 'This workspace has reached its limit of uploaded files. Delete some you no longer use.' },
  image_host_not_allowed: { status: 400, message: 'Pictures from that address are not allowed. Add the site under Images, Settings, Allowed picture sites, or upload the picture.' },
  bad_png: { status: 422, message: 'That file is not a PNG of the right size for this template.' },
  batch_running: { status: 409, message: 'This batch is still running. Wait for it to finish.' },
  batch_too_large: { status: 413, message: 'A batch can hold 100 rows at most. Split the file and run it in parts.' },
  batch_empty: { status: 422, message: 'There are no rows to render. Add at least one row under the header row.' },
  render_failed: { status: 500, message: 'We could not draw this image. Try again, and check the template in the editor if it keeps failing.' },
});
