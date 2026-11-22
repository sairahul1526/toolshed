/** Sample data for the first run: one waitlist with a believable crowd, referral chains and two reward tiers. */
import type { ModuleContext } from '../../core/module';
import { createWaitlist, addTier, deleteWaitlist, listWaitlists } from './waitlists';
import { importRows, type ImportMapping } from './transfer';

const PEOPLE = [
  ['Maya Chen', 'maya'], ['Tomas Novak', 'tomas'], ['Priya Nair', 'priya'], ['Leo Martins', 'leo'], ['Amara Okafor', 'amara'], ['Jonas Berg', 'jonas'],
  ['Sofia Rossi', 'sofia'], ['Kenji Sato', 'kenji'], ['Hana Kim', 'hana'], ['Omar Haddad', 'omar'], ['Lucy Park', 'lucy'], ['Ivan Petrov', 'ivan'],
  ['Elena Garcia', 'elena'], ['Noah Wilson', 'noah'], ['Zara Ali', 'zara'], ['Marco Bianchi', 'marco'], ['Ines Costa', 'ines'], ['Ravi Patel', 'ravi'],
  ['Freya Olsen', 'freya'], ['Diego Ruiz', 'diego'], ['Mei Lin', 'mei'], ['Sam Taylor', 'sam'], ['Aya Tanaka', 'aya'], ['Ben Cohen', 'ben'],
] as const;

/** Who referred whom, by index: the first few people brought most of the rest. */
const REFERRED_BY: Record<number, number> = { 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 1, 10: 1, 11: 1, 12: 2, 13: 2, 14: 3, 15: 4, 16: 4, 17: 6, 18: 8, 19: 9, 20: 9, 21: 12 };
const SOURCES = ['x', 'newsletter', 'friend', 'search'];

export async function addSampleWaitlist({ env, db }: ModuleContext): Promise<void> {
  const wl = await createWaitlist(db, { name: 'Sample launch list', headline: 'Be first in line', description: 'A sample waitlist with made-up people. Delete it any time.', status: 'live', show_count: 1 }, { sample: true });
  await addTier(db, wl.id, { referrals_required: 3, name: 'Early access', reward_text: 'Get in a week early' });
  await addTier(db, wl.id, { referrals_required: 6, name: 'Founding member', reward_text: 'Free for the first year' });
  const rows = PEOPLE.map(([name, id], i) => [`${id}@example.com`, name, `demo${id}`, REFERRED_BY[i] === undefined ? '' : `demo${PEOPLE[REFERRED_BY[i]!]![1]}`, SOURCES[i % SOURCES.length]!]);
  const map: ImportMapping = { email: 0, name: 1, code: 2, referredBy: 3, source: 4 };
  await importRows(env, wl, rows, map, { verified: true }, Date.now() - 6 * 86_400_000);
}

export async function clearSampleWaitlists({ db }: ModuleContext): Promise<void> {
  for (const wl of await listWaitlists(db)) if (wl.is_sample === 1) await deleteWaitlist(db, wl.id);
}
