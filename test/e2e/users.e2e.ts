import { expect, test } from '@playwright/test';
import { newPerson, signedInPage } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, watch } from './helpers/screen';

test.setTimeout(120_000);

/** Someone made for this test only, so shared test people are never banned or deleted. */
async function somebody(browser: import('@playwright/test').Browser, tag: string, name: string) {
  const { page, email } = await newPerson(browser, tag, name);
  await page.context().close();
  return { email, name };
}

const find = (email: string) => '/app/users?q=' + encodeURIComponent(email);

test('lists people, searches, and opens one person', async ({ browser }) => {
  const page = await signedInPage(browser);
  const mel = await somebody(browser, 'list', 'Lena Lister');

  const w = watch(page);
  await page.goto('/app/users');
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: mel.name })).toBeVisible();
  await shotThemes(page, 'users-list');

  await page.getByRole('searchbox', { name: 'Search people' }).fill('no-such-person-here');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'No one matches that' })).toBeVisible();
  await shot(page, 'users-no-match');
  await page.getByRole('article').getByRole('link', { name: 'Clear search' }).click();

  await page.getByRole('link', { name: mel.name }).click();
  await expect(page.getByRole('heading', { name: mel.name, level: 1 })).toBeVisible();
  await expect(page.getByText(mel.email).first()).toBeVisible();
  await shotThemes(page, 'users-detail');
  w.expectClean();
});

test('a person is banned, shown as banned, and let back in', async ({ browser }) => {
  const page = await signedInPage(browser);
  const vic = await somebody(browser, 'ban', 'Bea Bannable');

  const w = watch(page);
  await page.goto(find(vic.email));
  await page.getByRole('link', { name: vic.name }).click();

  await page.getByLabel('Reason').fill('Posting spam');
  await page.getByLabel('For how long').selectOption('7');
  await page.getByRole('button', { name: /^Ban / }).click();
  await expect(page.getByText(/is banned and signed out everywhere/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lift ban' })).toBeVisible();
  await shotThemes(page, 'users-banned');

  await page.getByRole('button', { name: 'Lift ban' }).click();
  await expect(page.getByText('The ban is lifted. They can sign in again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lift ban' })).toHaveCount(0);
  w.expectClean(['response 422', 'status of 422']);
});

test('deleting an account needs the email typed, then removes the person', async ({ browser }) => {
  const page = await signedInPage(browser);
  const adam = await somebody(browser, 'del', 'Dan Deletable');

  const w = watch(page);
  await page.goto(find(adam.email));
  await page.getByRole('link', { name: adam.name }).click();
  await page.getByLabel(/^Type .* to confirm$/).fill('wrong@example.com');
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByLabel(/^Type .* to confirm$/)).toHaveAttribute('aria-invalid', 'true');
  await shot(page, 'users-delete-error');
  await page.getByLabel(/^Type .* to confirm$/).fill(adam.email);
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL(/\/app\/users$/);
  await expect(page.getByText(`Deleted the account of ${adam.email}.`)).toBeVisible();
  await expect(page.getByRole('link', { name: adam.name })).toHaveCount(0);
  w.expectClean(['response 422', 'status of 422']);
});

test('sign in as someone, then stop', async ({ browser }) => {
  const page = await signedInPage(browser);
  const mel = await somebody(browser, 'sia', 'Sid Signedin');

  await page.goto(find(mel.email));
  await page.getByRole('link', { name: mel.name }).click();
  await page.getByRole('button', { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText(/You’re signed in as/).first()).toBeVisible();

  // While signed in as someone else the owner screens are closed.
  const closed = await page.request.get('/app/users', { headers: { accept: 'text/html' }, failOnStatusCode: false });
  expect(closed.status()).toBe(403);

  // The way back is the stop form, which the shell shows in its banner.
  await page.goto('/app/users', { waitUntil: 'domcontentloaded' });
  const res = await page.request.post('/app/users/impersonation/stop', { headers: { origin: new URL(page.url()).origin }, maxRedirects: 0, failOnStatusCode: false });
  expect(res.status()).toBe(303);
  await page.goto('/app/users');
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
});

test('a workspace is renamed and deleted from the Workspaces tab', async ({ browser }) => {
  const page = await signedInPage(browser);
  const other = await signedInPage(browser, { workspace: 'Scratch Shed' });
  await other.context().close();

  const w = watch(page);
  await page.goto('/app/users?tab=workspaces');
  await expect(page.getByRole('link', { name: 'Scratch Shed' })).toBeVisible();
  await shotThemes(page, 'users-workspaces');
  await page.getByRole('link', { name: 'Scratch Shed' }).click();

  await page.getByLabel('Name', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Name', { exact: true }).fill('Scratch Shed Two');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved\. The workspace is now Scratch Shed Two/)).toBeVisible();
  await shotThemes(page, 'users-workspace');

  const slug = (await page.getByLabel('Short name').inputValue()).trim();
  await page.getByLabel(/^Type .* to confirm$/).fill('nope');
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(page.getByLabel(/^Type .* to confirm$/)).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel(/^Type .* to confirm$/).fill(slug);
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(page).toHaveURL(/tab=workspaces/);
  await expect(page.getByText(/Deleted Scratch Shed Two/)).toBeVisible();
  w.expectClean(['response 422', 'status of 422']);
});

test('the pages hold at 375 px', async ({ browser }) => {
  const page = await signedInPage(browser);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/app/users', '/app/users?tab=workspaces']) {
    await page.goto(path);
    await expectNoSideScroll(page);
  }
  await shotThemes(page, 'users-mobile');
});
