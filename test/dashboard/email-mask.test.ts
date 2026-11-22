import { describe, expect, it } from 'vitest';
import { maskAddress } from '../../src/dashboard/email/mask';

describe('maskAddress', () => {
  it('keeps the first character and the domain', () => {
    expect(maskAddress('jo@example.com')).toBe('j***@example.com');
    expect(maskAddress('a@example.com')).toBe('a***@example.com');
    expect(maskAddress('first.last+tag@mail.example.co.uk')).toBe('f***@mail.example.co.uk');
  });

  it('does not cut a character in half', () => {
    expect(maskAddress('😀smile@example.com')).toBe('😀***@example.com');
    expect(maskAddress('émile@example.com')).toBe('é***@example.com');
  });

  it('hides anything that is not an address', () => {
    for (const odd of ['', 'nobody', '@example.com', 'jo@']) expect(maskAddress(odd)).toBe('***');
  });
});
