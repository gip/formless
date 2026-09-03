import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STARTER_FILES } from '../lib/starter-project';

/**
 * `lib/generated/starter-files.ts` used to be a Vite `import.meta.glob`, which
 * could not go stale. It is now generated and checked in, so this test is the
 * replacement guard: it re-derives the map from `guest/` on disk and fails when
 * someone edits the guest without re-running `pnpm generate:starter`.
 *
 * The stakes are higher than a stale preview. `starterPackageHash()` pins the
 * 15MB prebuilt runtime in `public/guest-runtime/`; if the checked-in map and
 * the real `guest/package.json` disagree, the snapshot silently stops matching.
 */

const guestRoot = resolve(__dirname, '..', 'guest');
const GUEST_EXTENSIONS = ['.ts', '.tsx', '.css', '.json', '.html', '.mjs'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.vite']);

async function collect(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await collect(absolute)));
    } else if (GUEST_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(absolute);
    }
  }
  return found;
}

describe('generated starter files', () => {
  it('matches guest/ on disk', async () => {
    const onDisk: Record<string, string> = {};
    for (const absolute of (await collect(guestRoot)).sort()) {
      const path = relative(guestRoot, absolute).split('\\').join('/');
      const contents = await readFile(absolute, 'utf8');
      onDisk[path] = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
    }

    const stale = Object.keys(onDisk).filter((path) => onDisk[path] !== STARTER_FILES[path]);
    expect(
      stale,
      `lib/generated/starter-files.ts is stale. Run \`pnpm generate:starter\`.`,
    ).toEqual([]);
    expect(Object.keys(STARTER_FILES).sort()).toEqual(Object.keys(onDisk).sort());
  });
});
