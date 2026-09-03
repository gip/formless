'use client';

import { isHealthExportDocument, type HealthExportDocument } from './types';

/**
 * A de-identified record, served from the host so `/explore` is reviewable
 * without an Epic account and the e2e suite has something deterministic to
 * assert against.
 *
 * It lives in the host's `public/` rather than the guest's, and deliberately so:
 * at ~4.5MB it would blow straight through the editable-overlay limits in
 * `project-policy.ts` (256KB per file, 1MB per batch) and the 2MB publish body
 * cap in `version-request.ts`. The host reads it and hands the parsed document
 * across the bridge instead.
 */

export const DEMO_RECORD_URL = '/demo/deidentified-john-smith.json';

let cached: Promise<HealthExportDocument | undefined> | null = null;

async function load(): Promise<HealthExportDocument | undefined> {
  try {
    // Not `force-cache`: that serves a stored copy without revalidating, which
    // means an edited fixture keeps showing its old contents until the browser
    // cache is cleared by hand. The default policy still gets a cheap 304.
    const response = await fetch(DEMO_RECORD_URL);
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    return isHealthExportDocument(value) ? value : undefined;
  } catch {
    // A missing demo fixture degrades to "no record", never to a broken preview.
    return undefined;
  }
}

/** Parsed once per document; the fixture is large enough that re-parsing is felt. */
export function loadDemoRecord(): Promise<HealthExportDocument | undefined> {
  cached ??= load();
  return cached;
}
