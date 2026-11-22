/** The one place this module imports the shared helpers from. */
export { baseUrl, clientIp, isBot, visitorId } from '../../core/net';
export { excerpt, markdownToText, renderMarkdown } from '../../core/markdown';
export { readSignedToken, sign, signedToken, verify } from '../../core/signing';
export { guessColumns, parseCsv, rowsToObjects } from '../../core/csv-parse';

import { renderMarkdown as render } from '../../core/markdown';

/** Markdown from a visitor: links only, never images, never raw HTML. */
export function renderVisitorMarkdown(src: string): string {
  return render(src, {});
}
