/**
 * A pretend passkey device for one page: Chrome's own virtual authenticator, with a fingerprint
 * that always matches. Passkeys made on it stay on it for the life of the page.
 */
import type { Page } from '@playwright/test';

const port = Number(process.env.PORT ?? 8787);

/**
 * The same app under a name. Browsers refuse passkeys on a bare IP address such as 127.0.0.1,
 * so passkey tests open the app here. Cookies do not carry over from the IP address.
 */
export const passkeyURL = `http://localhost:${port}`;

export async function addPasskeyDevice(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/**
 * Press an "Add a passkey" button on the page. The button belongs to the Account screen; until a
 * page has one, this puts the same markup on the current page and loads the real script, so the
 * whole ceremony runs exactly as it will there. Ends on `done`.
 */
const attr = (value: string) => `"${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;

export async function addPasskey(page: Page, name: string, done = '/app?passkey=added'): Promise<void> {
  const markup =
    `<input id="passkey-name" value=${attr(name)}>` +
    `<button type="button" data-passkey-add data-name="#passkey-name" data-done=${attr(done)} hidden>Add a passkey</button>` +
    '<p data-passkey-error role="alert" hidden></p>';
  // Written as text: the project does not load the browser's types.
  await page.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(markup)})`);
  await page.addScriptTag({ url: '/assets/auth.js' });
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.waitForURL((url) => url.pathname + url.search === done);
}
