/**
 * Hides most of an email address for lists that may be on screen while someone else is looking:
 * `jo@example.com` becomes `j***@example.com`. The domain stays, since it is what tells two
 * rows apart. Anything that is not an address is hidden whole.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return '***';
  const first = [...address.slice(0, at)][0] ?? '';
  return `${first}***${address.slice(at)}`;
}
