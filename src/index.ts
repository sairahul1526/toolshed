/**
 * Worker entry: HTTP, the jobs queue and the every-minute schedule.
 * The two generated files are written by `scripts/prepare.mjs` (run by every npm script that needs them).
 */
import { createApp } from './app';
import { handleQueue, runSchedules } from './core/jobs';
import { registerModules } from './core/registry';
import type { Env, JobMessage } from './env';
import { modules } from './generated/modules';
import { screens } from './generated/screens';

registerModules(modules);
const app = createApp({ screens });

export default {
  fetch: app.fetch,
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(runSchedules(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env, JobMessage>;
