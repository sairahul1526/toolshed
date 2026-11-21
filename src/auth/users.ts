/** Direct reads of the people table. One indexed query each. */
import { z } from 'zod';
import type { Env } from '../env';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  role: string | null;
  banned: number | null;
  banReason: string | null;
  banExpires: string | null;
  twoFactorEnabled: number | null;
  createdAt: string;
}

const COLUMNS = '"id", "email", "name", "username", "role", "banned", "banReason", "banExpires", "twoFactorEnabled", "createdAt"';

/** An email address as we store and compare it: trimmed and lower case. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter an email address like name@example.com.').max(254, 'That email is too long.'));

export function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM "user" WHERE "email" = ?1`).bind(email.toLowerCase()).first<UserRow>();
}

export function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM "user" WHERE "id" = ?1`).bind(id).first<UserRow>();
}

export function isBanned(user: Pick<UserRow, 'banned' | 'banExpires'>, now = Date.now()): boolean {
  return !!user.banned && (!user.banExpires || Date.parse(user.banExpires) > now);
}

/** Installs only ever go from unclaimed to claimed, so a yes is remembered for the life of the isolate. */
const claimed = new WeakSet<object>();

/** True once someone owns this install. */
export async function instanceClaimed(env: Env): Promise<boolean> {
  if (claimed.has(env.DB)) return true;
  const row = await env.DB.prepare(`SELECT 1 AS yes FROM "user" WHERE "role" = 'admin' LIMIT 1`).first<{ yes: number }>();
  if (row) claimed.add(env.DB);
  return !!row;
}
