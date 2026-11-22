/** Runs once before the end-to-end tests: claims the fresh install and saves the owner's sign-in. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { baseURL, ensureOwner, ownerState, setupLook } from './auth';
import { inspect } from './look';

export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    // The first-run pages exist only now. Note what is wrong with them and carry on: the auth
    // tests report it, so a layout slip there cannot stop every other test from starting.
    const problems: string[] = [];
    await ensureOwner(page, async (step) => {
      problems.push(...(await inspect(page, step)));
    });
    mkdirSync(dirname(ownerState), { recursive: true });
    writeFileSync(setupLook, JSON.stringify(problems));
    await context.storageState({ path: ownerState });
  } finally {
    await browser.close();
  }
}
