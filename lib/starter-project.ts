import type { FileMap } from './canvas-types';
import { GENERATED_STARTER_FILES } from './generated/starter-files';

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

/**
 * The guest file map is generated ahead of the build by
 * `scripts/generate-starter-files.mjs` and checked in, rather than inlined by
 * Vite's `import.meta.glob(..., { query: '?raw' })`. Next.js has no equivalent —
 * Turbopack supports neither glob imports nor `?raw` — and checking the output
 * in keeps `tsc`, `vitest`, and `next build` working without a generator step
 * having run first.
 *
 * The generator owns the extension allowlist and strips exactly one trailing
 * newline per file, so `starterPackageHash()` is unchanged from the Vite build
 * and the prebuilt runtime in `public/guest-runtime/` stays valid. Re-run
 * `pnpm generate:starter` after editing anything under `guest/`;
 * `tests/starter-files.test.ts` fails when the checked-in map drifts from disk.
 */
export const STARTER_FILES: FileMap = GENERATED_STARTER_FILES;

export function cloneStarterFiles(): FileMap {
  return { ...STARTER_FILES };
}
