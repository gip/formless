/**
 * Refreshes `public/directory/epic-r4.json` from Epic's published endpoint list.
 *
 * Run with `pnpm generate:directory`. Like `generate-starter-files.mjs` this is
 * human-invoked, not a build step: the output is committed so builds stay
 * reproducible and nothing depends on open.epic.com at runtime.
 *
 * Epic registers one app, and every customer organization that enables it accepts
 * the same client id — so an organization is fully described by a name and a FHIR
 * base URL. That is all this snapshot carries. Portal branding is *not* in the
 * source data: `lib/health/registry.ts` defaults directory entries to "MyChart",
 * and `lib/health/providers.ts` keeps the hand-written names for the few
 * organizations where we know better.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://open.epic.com/Endpoints/R4';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'public/directory/epic-r4.json');

/**
 * Organizations already described by hand in `lib/health/providers.ts`, matched
 * by name so they are offered once, under their curated profile.
 *
 * Deliberately **not** matched by `fhirBase`: affiliates share an Epic instance —
 * "UCSF Benioff Children's Hospital" resolves to the same base as "UCSF Health" —
 * so deduping on the URL would silently delete organizations a patient may well
 * be looking for.
 */
const CURATED_NAMES = new Set(['ucsf health', 'sutter health']);

/**
 * Mirrors `normalizeFhirBase` in `lib/health/epic.ts`, which is the function that
 * will actually run against these values at request time. Reimplemented rather
 * than imported because that module is TypeScript and browser-shaped; the copy is
 * six lines and `tests/epic-directory.test.ts` pins the committed snapshot against
 * the real implementation, so the two cannot drift silently.
 */
function normalizeFhirBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('FHIR endpoints must use HTTPS.');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function organizations(bundle) {
  if (bundle?.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) {
    throw new Error('Epic did not return a FHIR Bundle.');
  }
  return bundle.entry
    .map((entry) => entry?.resource)
    .filter((resource) => resource?.resourceType === 'Endpoint' && resource.status === 'active');
}

async function main() {
  process.stdout.write(`Fetching ${SOURCE_URL}\n`);
  const response = await fetch(SOURCE_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Epic returned HTTP ${response.status}.`);

  const endpoints = organizations(await response.json());
  const seen = new Map();
  const rows = [];
  const skipped = [];

  for (const endpoint of endpoints) {
    // Several names arrive with trailing whitespace ("UCSF Health ").
    const name = String(endpoint.name ?? '').trim();
    if (!name) {
      skipped.push('(unnamed endpoint)');
      continue;
    }
    if (CURATED_NAMES.has(name.toLowerCase())) continue;

    let fhirBase;
    try {
      fhirBase = normalizeFhirBase(String(endpoint.address ?? ''));
    } catch {
      skipped.push(name);
      continue;
    }

    // Slugs are collision-free across the current directory, but the snapshot
    // gets refreshed against data we have not seen yet.
    let id = slugify(name);
    if (!id) {
      skipped.push(name);
      continue;
    }
    const priorCount = seen.get(id);
    if (priorCount) {
      seen.set(id, priorCount + 1);
      id = `${id}-${priorCount + 1}`;
    } else {
      seen.set(id, 1);
    }

    rows.push({ id, name, fhirBase });
  }

  rows.sort((left, right) => left.name.localeCompare(right.name));

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');

  process.stdout.write(`Wrote ${rows.length} organizations to public/directory/epic-r4.json\n`);
  if (skipped.length) {
    process.stdout.write(`Skipped ${skipped.length} unusable endpoint(s): ${skipped.join(', ')}\n`);
  }
}

await main();
