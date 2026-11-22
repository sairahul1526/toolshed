/** Runs once before the end-to-end tests: claims the fresh install and saves the owner's sign-in. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { baseURL, ensureOwner, ownerState } from './auth';

export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    await ensureOwner(await context.newPage());
    mkdirSync(dirname(ownerState), { recursive: true });
    await context.storageState({ path: ownerState });
  } finally {
    await browser.close();
  }
}
