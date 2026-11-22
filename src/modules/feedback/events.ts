import { emit } from '../../core/events';
import type { Env } from '../../env';

export const EVENTS = ['post.created', 'post.status_changed', 'post.merged', 'post.voted', 'comment.created', 'changelog.published', 'person.verified'];

/**
 * `post.voted` is thresholded so a viral post cannot flood the event log or a webhook. It fires once
 * each time a post's vote count first reaches one of these numbers.
 */
export const VOTE_MILESTONES = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export function nextMilestone(count: number, reached: number): number | null {
  let hit: number | null = null;
  for (const m of VOTE_MILESTONES) if (m <= count && m > reached) hit = m;
  return hit;
}

export function emitFb(env: Env, orgId: string, name: string, subject: string | undefined, data: Record<string, unknown>): Promise<void> {
  return emit(env, { orgId, module: 'feedback', name, subject, data });
}
