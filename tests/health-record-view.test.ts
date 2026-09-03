import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  htmlToPlainText,
  listEntries,
  primaryDate,
  readEntries,
  summarizeRecord,
  MAX_TOOL_RESULT_BYTES,
} from '../lib/health/record-view';
import { isHealthExportDocument, type HealthExportDocument } from '../lib/health/types';

/**
 * Driven against the real de-identified fixture rather than a hand-written
 * stub, the way `runtime-snapshot.test.ts` reads `public/guest-runtime/` off
 * disk. Nothing else in the suite touches it, and a read model whose whole job
 * is surviving a dense clinical record should be exercised on one: 1,400-odd
 * resources, seventeen groups, base64 note bodies and a provider error string.
 */
const record = (() => {
  const raw: unknown = JSON.parse(
    readFileSync(join(process.cwd(), 'public/demo/deidentified-john-smith.json'), 'utf8'),
  );
  if (!isHealthExportDocument(raw)) throw new Error('The demo fixture is not a health export document.');
  return raw as HealthExportDocument;
})();

describe('summarizeRecord', () => {
  it('counts every group and dates it', () => {
    const summary = summarizeRecord(record);

    expect(summary.totals.resources).toBe(1412);
    expect(summary.totals.groups).toBe(summary.groups.length);
    expect(summary.totals.attachments).toBe(65);
    expect(summary.provenance.provider).toBeTruthy();

    const observations = summary.groups.find((group) => group.key === 'Observation');
    expect(observations).toMatchObject({ label: 'Observations', count: 486 });
    expect(observations?.earliest).toBeTruthy();
    expect(observations?.latest).toBeTruthy();
    // The span has to run the right way round, which is the whole point of
    // per-type date extraction.
    expect(observations!.earliest! < observations!.latest!).toBe(true);
    expect(observations?.commonTitles.length).toBeGreaterThan(0);
    // Observation is fetched as three category variants collapsed under one
    // key; the summary breaks them back out.
    expect(Object.keys(observations?.categories ?? {}).length).toBeGreaterThan(1);
  });

  it('reports the patient and the provider errors rather than hiding them', () => {
    const summary = summarizeRecord(record);
    expect(summary.patient?.name).toBeTruthy();
    expect(summary.patient?.birthDate).toBeTruthy();
    // An empty group is not proof of an empty history — the agent needs to know
    // which searches the provider refused.
    expect(summary.importErrors.some((entry) => entry.group === 'Binary')).toBe(true);
  });

  it('groups clinical-note files and notices they carry text', () => {
    const summary = summarizeRecord(record);
    const binary = summary.groups.find((group) => group.key === 'Binary');
    expect(binary).toMatchObject({ label: 'Clinical-note files', count: 65 });
    expect(binary?.withText).toBe(65);
    expect(summary.totals.notesWithText).toBe(65);
  });
});

describe('listEntries', () => {
  it('pages newest first and reports where to resume', () => {
    const page = listEntries(record, { group: 'Observation', limit: 5 });
    expect(page.total).toBe(486);
    expect(page.returned).toBe(5);
    expect(page.nextOffset).toBe(5);
    expect(page.entries.every((entry) => entry.ref.startsWith('Observation/'))).toBe(true);

    const dates = page.entries.map((entry) => entry.date).filter(Boolean) as string[];
    expect([...dates].sort().reverse()).toEqual(dates);
    // Ordering alone is not enough: the oldest five observations share a
    // timestamp, so an ascending sort would satisfy the check above. The top of
    // a date_desc page has to be the group's newest resource.
    const latest = summarizeRecord(record).groups.find((group) => group.key === 'Observation')!.latest;
    expect(page.entries[0].date).toBe(latest);

    const ascending = listEntries(record, { group: 'Observation', limit: 1, sort: 'date_asc' });
    expect(ascending.entries[0].date)
      .toBe(summarizeRecord(record).groups.find((group) => group.key === 'Observation')!.earliest);

    const next = listEntries(record, { group: 'Observation', limit: 5, offset: page.nextOffset! });
    expect(next.entries[0].ref).not.toBe(page.entries[0].ref);
  });

  it('accepts a group by its patient-facing label as well as its key', () => {
    expect(listEntries(record, { group: 'Medications' }).total)
      .toBe(listEntries(record, { group: 'MedicationRequest' }).total);
  });

  it('runs the last page out without a nextOffset', () => {
    const page = listEntries(record, { group: 'AllergyIntolerance' });
    expect(page.total).toBe(2);
    expect(page.nextOffset).toBeNull();
  });

  it('filters by date range, status and free text', () => {
    const bounded = listEntries(record, { group: 'Encounter', from: '2020-01-01' });
    expect(bounded.total).toBeLessThan(listEntries(record, { group: 'Encounter' }).total);
    expect(bounded.entries.every((entry) => (entry.date ?? '') >= '2020-01-01')).toBe(true);

    const all = listEntries(record, { group: 'Condition', limit: 200 });
    const status = all.entries.find((entry) => entry.status)?.status as string;
    const filtered = listEntries(record, { group: 'Condition', status, limit: 200 });
    expect(filtered.total).toBeGreaterThan(0);
    expect(filtered.entries.every((entry) => entry.status === status)).toBe(true);

    const word = all.entries[0].title.split(' ')[0].toLowerCase();
    const searched = listEntries(record, { query: word, limit: 200 });
    expect(searched.total).toBeGreaterThan(0);
    expect(searched.entries.every((entry) =>
      `${entry.title} ${entry.summary ?? ''}`.toLowerCase().includes(word))).toBe(true);
  });

  it('sorts undated resources last whichever way the dated ones run', () => {
    const ascending = listEntries(record, { limit: 200, sort: 'date_asc' });
    const firstUndated = ascending.entries.findIndex((entry) => !entry.date);
    if (firstUndated >= 0) {
      expect(ascending.entries.slice(firstUndated).every((entry) => !entry.date)).toBe(true);
    }
  });

  it('stays inside the result budget on a wide listing', () => {
    const page = listEntries(record, { limit: 200 });
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES + 2_000);
    if (page.truncated) expect(page.guidance).toBeTruthy();
  });
});

describe('readEntries', () => {
  it('renders labelled fields by default', () => {
    const ref = listEntries(record, { group: 'Condition', limit: 1 }).entries[0].ref;
    const result = readEntries(record, [ref]);
    expect(result.missing).toEqual([]);
    expect(result.items[0].ref).toBe(ref);
    expect(result.items[0].fields?.length).toBeGreaterThan(0);
    expect(result.items[0].fhir).toBeUndefined();
  });

  it('returns the verbatim FHIR resource on request', () => {
    const ref = listEntries(record, { group: 'Observation', limit: 1 }).entries[0].ref;
    const item = readEntries(record, [ref], 'fhir').items[0];
    expect(item.fhir?.resourceType).toBe('Observation');
    // Verbatim means verbatim: the coding systems Epic returned are still there.
    expect(item.fhir?.code).toBeDefined();
  });

  it('resolves a bare id as well as a Group/id ref, and reports what it cannot find', () => {
    const ref = listEntries(record, { group: 'Immunization', limit: 1 }).entries[0].ref;
    const bare = ref.slice(ref.indexOf('/') + 1);
    expect(readEntries(record, [bare]).items[0].ref).toBe(ref);
    expect(readEntries(record, ['Condition/not-a-real-id']).missing).toEqual(['Condition/not-a-real-id']);
  });

  it('decodes clinical-note prose and pages through it', () => {
    const note = listEntries(record, { group: 'Binary', limit: 1 }).entries[0];
    expect(note.hasText).toBe(true);

    const full = readEntries(record, [note.ref], 'text').items[0];
    expect(full.text).toBeTruthy();
    // The fixture stores notes as base64 HTML; a reader should get prose.
    expect(full.text).not.toContain('<br>');
    expect(full.text).not.toContain('&nbsp;');
    expect(full.totalChars).toBe(full.text!.length);

    const windowed = readEntries(record, [note.ref], 'text', { maxChars: 40 }).items[0];
    expect(windowed.text!.length).toBe(40);
    expect(windowed.textTruncated).toBe(true);
    expect(windowed.text).toBe(full.text!.slice(0, 40));

    const offset = readEntries(record, [note.ref], 'text', { textOffset: 40, maxChars: 40 }).items[0];
    expect(offset.text).toBe(full.text!.slice(40, 80));
  });

  it('omits the base64 body from a Binary read as FHIR and says where to find it', () => {
    const note = listEntries(record, { group: 'Binary', limit: 1 }).entries[0];
    const item = readEntries(record, [note.ref], 'fhir').items[0];
    expect(item.fhir?.data).toBeUndefined();
    expect(item.note).toContain('format: "text"');
  });

  it('explains a text read of a resource that has none', () => {
    const ref = listEntries(record, { group: 'Condition', limit: 1 }).entries[0].ref;
    const item = readEntries(record, [ref], 'text').items[0];
    expect(item.text).toBeUndefined();
    expect(item.note).toContain('clinical-note files');
  });

  it('stops inside the result budget rather than returning everything asked for', () => {
    const refs = listEntries(record, { group: 'Observation', limit: 20 }).entries.map((entry) => entry.ref);
    const result = readEntries(record, refs, 'fhir');
    expect(JSON.stringify(result.items).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES + 20_000);
    if (result.truncated) expect(result.guidance).toBeTruthy();
  });
});

describe('htmlToPlainText', () => {
  it('turns markup into prose without a DOM', () => {
    expect(htmlToPlainText('<br>EGD REPORT&nbsp;&nbsp;DATE: 12/02/2016<br><br>Findings')).toBe(
      'EGD REPORT  DATE: 12/02/2016\n\nFindings',
    );
  });

  it('drops scripts and styles instead of reading them out', () => {
    expect(htmlToPlainText('<style>p{color:red}</style><p>Visible</p><script>alert(1)</script>')).toBe('Visible');
  });

  it('decodes numeric and named entities', () => {
    expect(htmlToPlainText('A &amp; B &#39;quoted&#39; &lt;tag&gt;')).toBe("A & B 'quoted' <tag>");
  });
});

describe('primaryDate', () => {
  it('reads the date off the field each resource type actually uses', () => {
    expect(primaryDate({ resourceType: 'Encounter', period: { start: '2021-03-04' } })).toBe('2021-03-04');
    expect(primaryDate({ resourceType: 'MedicationDispense', whenHandedOver: '2022-06-01' })).toBe('2022-06-01');
    expect(primaryDate({ resourceType: 'Observation', effectiveDateTime: '2020-01-01T10:00:00Z' }))
      .toBe('2020-01-01T10:00:00Z');
    // An unnamed type still gets a date through the generic fallback.
    expect(primaryDate({ resourceType: 'Whatever', created: '2019-09-09' })).toBe('2019-09-09');
    expect(primaryDate({ resourceType: 'Condition' })).toBeUndefined();
  });
});
