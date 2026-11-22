import { expect, test } from '@playwright/test';
import { baseURL, enterCode, newPerson, outboxMark, ownerState, readCode, RUN, signInAs } from './helpers/auth';
import { addPasskeyDevice, passkeyURL } from './helpers/passkey';
import { expectNoSideScroll, shot, shotThemes, shotView, watch } from './helpers/screen';
import { secretFromUri, totp } from './helpers/totp';

const PASSWORD = 'a long enough password';
/** Refusals these tests cause on purpose. */
const REFUSED = ['response 400', 'response 403', 'response 422', 'status of 400', 'status of 422'];

test('name, username and email: each change is checked next to its own field', async ({ browser }) => {
  const { page, email } = await newPerson(browser, 'acct', 'Nat Newcomer');
  const w = watch(page);
  await page.goto('/app/account');
  await expect(page.getByRole('heading', { name: 'Your account', level: 1 })).toBeVisible();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await shotThemes(page, 'account');

  await page.getByLabel('Full name').fill('Nat Renamed');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Name saved.')).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveValue('Nat Renamed');

  // A username needs a password, so the box is switched off and says why.
  await expect(page.getByLabel('Username')).toBeDisabled();
  await expect(page.getByText('A username needs a password.')).toBeVisible();

  // The same address, then a new one with a wrong code, then the right one.
  await page.getByLabel('New email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('New email address')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
  await shot(page, 'account-email-error');

  const next = `acct-new-${RUN}@example.com`;
  const mark = await outboxMark(page.request, next);
  await page.getByLabel('New email address').fill(next);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Check your inbox')).toBeVisible();
  await shot(page, 'account-email-pending');
  await enterCode(page, '000000');
  await expect(page.locator('#email-code-error')).toBeVisible();
  await shot(page, 'account-email-wrong-code');

  await enterCode(page, await readCode(page.request, next, { after: mark }));
  await expect(page.getByText(`Your email is now ${next}.`)).toBeVisible();
  await expect(page.getByText(`Signed in as ${next}`)).toBeVisible();

  // Starting a change and thinking better of it leaves nothing behind.
  await page.getByLabel('New email address').fill(`never-${RUN}@example.com`);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByRole('button', { name: 'Cancel change' }).click();
  await expect(page.getByText('The email change was cancelled.')).toBeVisible();
  await expect(page.getByLabel('New email address')).toBeVisible();
  w.expectClean(REFUSED);
  await page.context().close();
});

test('deleting the account needs the typed email and signs the person out', async ({ browser }) => {
  const { page, email } = await newPerson(browser, 'gone', 'Gil Goner');
  const w = watch(page);
  await page.goto('/app/account');
  await page.getByLabel(`Type ${email} to confirm`).fill('wrong');
  await page.getByRole('button', { name: 'Delete account' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete my account' }).click();
  await expect(page.getByLabel(`Type ${email} to confirm`)).toHaveAttribute('aria-invalid', 'true');
  await shot(page, 'account-delete-error');

  await page.getByLabel(`Type ${email} to confirm`).fill(email.toUpperCase());
  await page.getByRole('button', { name: 'Delete account' }).click();
  await shotView(page, 'account-delete-dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete my account' }).click();
  await page.waitForURL(/\/sign-in/);
  await expect(page.getByText('Your account was deleted.')).toBeVisible();
  w.expectClean(REFUSED);
  await page.context().close();
});

test('the owner of a workspace is told which workspaces stop them deleting', async ({ browser }) => {
  const page = await (await browser.newContext({ baseURL, storageState: ownerState })).newPage();
  await page.goto('/app/account');
  await expect(page.getByText('You are the only owner of these workspaces')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete account' })).toBeDisabled();
  await shot(page, 'account-delete-blocked');
  await page.context().close();
});

test('password and two-step: secrets are shown once and a wrong code is a message, not an error page', async ({ browser }) => {
  const { page } = await newPerson(browser, 'sec', 'Sam Secure');
  const w = watch(page);
  await page.goto('/app/account?tab=security');
  await shotThemes(page, 'account-security');

  await page.getByLabel('Password', { exact: true }).fill('x'.repeat(300));
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Password saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();

  // With a password, two-step asks for it first.
  await page.getByLabel('Current password').fill('not the password');
  await page.getByRole('button', { name: 'Set up two-step' }).click();
  await expect(page.locator('#current-start-error')).toBeVisible();
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up two-step' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in', level: 1 })).toBeVisible();
  await expect(page.getByText('Save these now')).toBeVisible();
  const secret = (await page.locator('.secret code').first().textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  expect(secretFromUri(`otpauth://totp/x?secret=${secret}`)).toBe(secret);
  await shotThemes(page, 'account-two-step-setup');

  await enterCode(page, '000000');
  await expect(page.locator('#two-step-code-error')).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  await shot(page, 'account-two-step-retry');
  await enterCode(page, totp(secret));
  await expect(page.getByText('Two-step sign-in is on.')).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  // Nothing of the setup is left on the page that follows, or after a reload.
  await page.reload();
  await expect(page.getByText(secret)).toHaveCount(0);

  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Make new recovery codes' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Make new codes' }).click();
  await expect(page.getByRole('heading', { name: 'New recovery codes', level: 1 })).toBeVisible();
  await shot(page, 'account-recovery-codes');
  await page.getByRole('link', { name: 'I have saved them' }).click();

  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Turn off two-step' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Two-step sign-in is off.')).toBeVisible();

  // With a password, a username can be set. Then the password goes and so does it.
  await page.goto('/app/account');
  await page.getByLabel('Username').fill('sam.secure');
  await page.getByRole('button', { name: 'Save username' }).click();
  await expect(page.getByText('Username saved.')).toBeVisible();
  w.expectClean(REFUSED);
  await page.context().close();
});

test('passkeys are added, renamed and removed, and devices can be signed out', async ({ browser }) => {
  const { page: first, email } = await newPerson(browser, 'devices', 'Dee Devices');
  await first.context().close();

  const page = await (await browser.newContext({ baseURL: passkeyURL })).newPage();
  const w = watch(page);
  await addPasskeyDevice(page);
  await signInAs(page, email, passkeyURL);
  await page.goto('/app/account?tab=security');
  await expect(page.getByText('No passkeys yet.')).toBeVisible();
  await page.getByLabel('Name for the new passkey').fill('Test laptop');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.locator('b', { hasText: 'Test laptop' })).toBeVisible();
  await shot(page, 'account-passkeys');

  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Desk laptop');
  await page.getByRole('dialog').getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Passkey renamed.')).toBeVisible();
  await expect(page.locator('b', { hasText: 'Desk laptop' })).toBeVisible();

  // A second browser signs in as the same person and shows up under Devices.
  const other = await (await browser.newContext({ baseURL })).newPage();
  await signInAs(other, email);
  await page.goto('/app/account?tab=sessions');
  await expect(page.getByText('This device')).toHaveCount(1);
  // Earlier sign-ins in this test left sessions behind, so there is more than one other device.
  await expect(page.getByRole('main').getByRole('button', { name: 'Sign out', exact: true })).not.toHaveCount(0);
  await shotThemes(page, 'account-devices');

  await page.getByRole('main').getByRole('button', { name: 'Sign out all other devices' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out others' }).click();
  await expect(page.getByText(/^Signed out \d+ other device/)).toBeVisible();
  expect((await other.request.get(`${baseURL}/app`, { maxRedirects: 0 })).status()).toBe(302);
  await expect(page.getByRole('button', { name: 'Sign out all other devices' })).toBeDisabled();

  await page.goto('/app/account?tab=security');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove passkey' }).click();
  await expect(page.getByText('Passkey removed.')).toBeVisible();
  await expect(page.getByText('No passkeys yet.')).toBeVisible();
  await expectNoSideScroll(page);
  w.expectClean(REFUSED);
  await other.context().close();
  await page.context().close();
});
