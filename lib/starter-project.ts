import type { FileMap } from './canvas-types';

/**
 * The guest project lives as real files under `guest/` and is inlined here at
 * build time. It used to be a map of escaped template literals in this file;
 * that stopped scaling once the guest became a real application, because every
 * backtick, `${`, and regex backslash had to be hand-escaped and nothing could
 * lint or syntax-highlight it.
 *
 * `guest/` is excluded from the host tsconfig and eslint config: it targets its
 * own React version and imports `./agent/bridge`, so host type-checking would
 * only produce noise. Guest syntax is checked in-container by
 * `guest/scripts/validate-syntax.mjs`, and `tests/guest-audit.test.ts` runs the
 * instrumentation audit over `guest/src` at host test time.
 *
 * Two details in `guest/package.json` exist to keep the prebuilt runtime in
 * `public/guest-runtime/` usable (see lib/runtime-snapshot.ts):
 *   - scripts call `node node_modules/<pkg>/…` instead of the bare binary,
 *     because a remounted snapshot loses the executable bit on node_modules/.bin
 *     and `npm run dev` would fail with `jsh: spawn vite EACCES`.
 *   - @rolldown/binding-wasm32-wasi is pinned to rolldown's version so vite does
 *     not stop to download it on every dev-server start (~2.5s).
 */

const GUEST_PREFIX = '../guest/';

/**
 * Only files the guest project actually needs. An allowlist rather than an
 * ignore list, so an editor artefact or a stray fixture dropped into `guest/`
 * can never be mounted into the WebContainer.
 */
const GUEST_EXTENSIONS = ['.ts', '.tsx', '.css', '.json', '.html', '.mjs'];

const sources = import.meta.glob('../guest/**/*', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * Files on disk carry the trailing newline every sane editor writes; the
 * original template literals did not. Stripping exactly one keeps
 * `starterPackageHash()` stable, so moving the guest to real files does not
 * invalidate the 15MB prebuilt runtime snapshot.
 * `tests/runtime-snapshot.test.ts` is the guard.
 */
function stripOneTrailingNewline(contents: string): string {
  return contents.endsWith('\n') ? contents.slice(0, -1) : contents;
}

function collectStarterFiles(): FileMap {
  const files: FileMap = {};
  for (const key of Object.keys(sources).sort()) {
    if (!key.startsWith(GUEST_PREFIX)) continue;
    const path = key.slice(GUEST_PREFIX.length);
    if (!GUEST_EXTENSIONS.some((extension) => path.endsWith(extension))) continue;
    files[path] = stripOneTrailingNewline(sources[key]);
  }
  return files;
}

export const STARTER_FILES: FileMap = collectStarterFiles();

export function cloneStarterFiles(): FileMap {
  return { ...STARTER_FILES };
}
