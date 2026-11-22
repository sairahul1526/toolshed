import { expect, test, type Browser } from '@playwright/test';
import { baseURL, newPerson, OWNER_NAME, ownerState, RUN, signedInPage } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, shotView, watch } from './helpers/screen';

/** Tests that make other people start signed out, so those people do not inherit the owner's sign-in. */
test.use({ storageState: { cookies: [], origins: [] } });

async function asOwner(browser: Browser) {
  return (await browser.newContext({ baseURL, storageState: ownerState })).newPage();
}

test('the owner sees the people, the invite form and what each role can do', async ({ browser }) => {
  const page = await asOwner(browser);
  const w = watch(page);
  await page.goto('/app/members');
  await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(OWNER_NAME) })).toContainText('(you)');
  await expect(page.getByRole('heading', { name: 'Invite people' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What each role can do' })).toBeVisible();
  await shotThemes(page, 'members');

  // Search keeps what was typed and has its own empty state.
  await page.getByRole('searchbox', { name: 'Search members' }).fill('nobody-by-this-name');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('heading', { name: 'No one matches' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search members' })).toHaveValue('nobody-by-this-name');
  await shot(page, 'members-no-match');
  await page.getByRole('link', { name: 'Clear filters' }).click();
  await expect(page.getByRole('row', { name: new RegExp(OWNER_NAME) })).toBeVisible();
  w.expectClean();
});

test('an invite is made, listed, sent again and cancelled', async ({ browser }) => {
  const page = await asOwner(browser);
  const w = watch(page);
  const email = `invitee-${RUN}@example.com`;
  await page.goto('/app/members');

  // A refused address is explained next to the field and kept.
  await page.locator('form[action="/app/members/invite"]').evaluate((f) => f.setAttribute('novalidate', ''));
  await page.getByLabel('Email address').fill('not an email');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Email address')).toHaveValue('not an email');
  await shot(page, 'members-invite-error');

  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption('viewer');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page).toHaveURL(/tab=invites/);
  await expect(page.getByText(`Invite sent to ${email}.`)).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(email) });
  await expect(row).toContainText('Viewer');
  await expect(row).toContainText('Works 7 more days');
  await shotThemes(page, 'members-invites');

  await row.getByRole('button', { name: 'Resend' }).click();
  await expect(page.getByText(`Invite sent again to ${email}.`)).toBeVisible();

  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(`Cancel the invite for ${email}?`);
  await shotView(page, 'members-confirm-cancel');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel invite' }).click();
  await expect(page.getByText('Invite cancelled. Its link stops working now.')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(email) })).toHaveCount(0);
  await shot(page, 'members-invites-empty');
  w.expectClean(['response 422', 'status of 422']);
});

test('a role is changed and the person is removed, after a question', async ({ browser }) => {
  const page = await asOwner(browser);
  test.setTimeout(90_000);
  const w = watch(page);
  const name = 'Rae Removable';
  const { page: theirs, email } = await newPerson(browser, 'remove', name);
  try {
    await page.goto('/app/members');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText(email);
    await row.getByLabel(`Role for ${name}`).selectOption('viewer');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`${name} is now Viewer.`)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(name) }).getByLabel(`Role for ${name}`)).toHaveValue('viewer');

    // The owner row has no controls, so a role cannot be changed by mistake.
    await expect(page.getByRole('row', { name: new RegExp(OWNER_NAME) }).getByRole('combobox')).toHaveCount(0);

    await page.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('dialog')).toContainText(`Remove ${name}?`);
    await expect(page.getByRole('dialog')).toContainText('Links, forms and anything else they made stay in the workspace.');
    await shotView(page, 'members-confirm-remove');
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText(`${name} was removed and signed out of this workspace.`)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
    w.expectClean();
  } finally {
    await theirs.context().close();
  }
});

test('someone who is not an admin sees the list read-only and can leave', async ({ browser }) => {
  test.setTimeout(90_000);
  const viewer = await signedInPage(browser, { role: 'viewer' });
  try {
    const w = watch(viewer);
    await viewer.goto('/app/members');
    await expect(viewer.getByText('You can look but not change')).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Send invite' })).toHaveCount(0);
    await expect(viewer.getByRole('combobox', { name: /^Role for/ })).toHaveCount(0);
    await shotThemes(viewer, 'members-viewer');
    w.expectClean();
  } finally {
    await viewer.context().close();
  }

  const { page: leaver } = await newPerson(browser, 'leave', 'Lee Leaver');
  try {
    await leaver.goto('/app/members');
    await leaver.getByRole('row', { name: /Lee Leaver/ }).getByRole('button', { name: 'Leave' }).click();
    await expect(leaver.getByRole('dialog')).toContainText('Leave this workspace?');
    await leaver.getByRole('dialog').getByRole('button', { name: 'Leave workspace' }).click();
    await leaver.waitForURL((url) => url.pathname === '/app' || url.pathname.startsWith('/setup') || url.pathname.startsWith('/welcome'));
    await expect(leaver.getByRole('row', { name: /Lee Leaver/ })).toHaveCount(0);
  } finally {
    await leaver.context().close();
  }
});

test('the page holds up at phone width', async ({ browser }) => {
  const page = await asOwner(browser);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/app/members');
  await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
  await expectNoSideScroll(page);
});
