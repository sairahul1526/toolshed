import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveIcon } from '../../src/ui/icons';

/** Every `icon="name"` or `icon: 'name'` written in src must be an icon the kit can draw. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('icon names used in src', () => {
  it('all exist in the kit', () => {
    const unknown: string[] = [];
    for (const file of sources('src')) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bicon(?:=|:\s*)["']([a-z0-9-]+)["']/g)) {
        const name = m[1] as string;
        if (!resolveIcon(name)) unknown.push(`${file}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
