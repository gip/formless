import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeFhirBase } from '../lib/health/epic';
import { PROVIDERS } from '../lib/health/providers';

/**
 * Invariants for the committed Epic directory snapshot.
 *
 * `scripts/fetch-epic-directory.mjs` is run by hand against a live third-party
 * feed, so the shape of what lands in the repo is not guaranteed by anything the
 * build controls. These assertions are the guard: a refresh that pulls in a
 * malformed endpoint, a duplicate id, or an organization already described by
 * hand fails here rather than at a patient's sign-in.
 *
 * The script reimplements `normalizeFhirBase` (it is plain `.mjs` and cannot
 * import TypeScript). This test closes that loop by re-checking every committed
 * row against the real implementation — the one that will actually run at
 * request time.
 */

interface DirectoryRow {
  id: string;
  name: string;
  fhirBase: string;
}

const rows: DirectoryRow[] = JSON.parse(
  readFileSync(resolve(__dirname, '../public/directory/epic-r4.json'), 'utf8'),
);

describe('epic directory snapshot', () => {
  it('carries the whole published directory', () => {
    // Epic's list grows; this is a floor, not an exact count, so a refresh that
    // adds organizations passes and one that silently truncates does not.
    expect(rows.length).toBeGreaterThan(400);
  });

  it('gives every organization an id, a name and an HTTPS base', () => {
    for (const row of rows) {
      expect(row.id).toMatch(/^[a-z0-9-]+$/);
      expect(row.name.trim()).toBe(row.name);
      expect(row.name).not.toBe('');
      expect(row.fhirBase).toMatch(/^https:\/\//);
    }
  });

  it('stores bases already in the form the FHIR client will use', () => {
    // If these differ, every request pays a silent rewrite and the dedupe below
    // compares the wrong strings.
    for (const row of rows) {
      expect(normalizeFhirBase(row.fhirBase)).toBe(row.fhirBase);
    }
  });

  it('assigns unique ids', () => {
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('omits organizations the curated registry already describes', () => {
    // Matched by name, not by fhirBase: affiliates share an Epic instance, so
    // deduping on the URL would drop organizations a patient may be looking for
    // (UCSF Benioff Children's shares a base with UCSF Health).
    const curated = new Set(Object.values(PROVIDERS).map((provider) => provider.name.toLowerCase()));
    for (const row of rows) {
      expect(curated.has(row.name.toLowerCase())).toBe(false);
    }
  });

  it('keeps affiliates that merely share an endpoint with a curated provider', () => {
    const ucsf = PROVIDERS.ucsf.fhirBase;
    expect(rows.some((row) => row.fhirBase === ucsf)).toBe(true);
  });
});
