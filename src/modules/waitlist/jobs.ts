/** Queue jobs and the schedule that restarts anything that stopped. */
import type { JobHandler, Schedule } from '../../core/module';
import { broadcastStep, resumeLaunches, waveStep } from './launch';
import { runBulk, type BulkJob } from './review';
import { processSignup } from './signups';

export const jobs: Record<string, JobHandler> = {
  'process-signup': async (env, payload) => {
    const p = payload as { signupId: string; base: string };
    await processSignup(env, p.signupId, p.base);
  },
  bulk: async (env, payload) => {
    await runBulk(env, payload as BulkJob);
  },
  wave: async (env, payload) => {
    const p = payload as { orgId: string; waveId: string };
    await waveStep(env, p.orgId, p.waveId);
  },
  broadcast: async (env, payload) => {
    const p = payload as { orgId: string; broadcastId: string };
    await broadcastStep(env, p.orgId, p.broadcastId);
  },
};

export const schedules: Schedule[] = [{ name: 'resume', every: '5min', run: (env, at) => resumeLaunches(env, at.getTime()) }];
