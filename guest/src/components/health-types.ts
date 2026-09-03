/**
 * The record shape this app renders.
 *
 * Deliberately types only: the app never fetches, decrypts, or stores a record.
 * It asks the host for one through `hostRecord.get()` and displays what comes
 * back, so no credential or key is reachable from code an agent can rewrite.
 *
 * Mirrors `lib/health/types.ts` on the host side.
 */

export type JsonObject = Record<string, unknown>;

export interface HealthAttachmentSummary {
  key: string;
  binaryId: string;
  contentType: string;
  size: number;
  sourceDocumentReference?: string;
  title?: string;
  /** The note body, for text attachments only. Absent on older records. */
  text?: string;
}

export interface BrowserStorageSummary {
  persistent: boolean;
  quota?: number;
  usage?: number;
}

export interface HealthExportDocument {
  schemaVersion: 1;
  exportedAt: string;
  exportedBy: string;
  source: {
    provider: string;
    fhirBase: string;
    patientId: string;
  };
  purpose: string;
  limitations: string[];
  data: Record<string, unknown>;
  errors: Record<string, string>;
  priorAuthorizations: JsonObject[];
  attachments?: HealthAttachmentSummary[];
  browserStorage?: BrowserStorageSummary;
}

export interface ProviderOption {
  id: string;
  label: string;
  myChartName: string;
  sandbox?: boolean;
}

/**
 * The organizations the connect panel can offer *before* the host answers.
 *
 * Deliberately only the hand-written few, not the registry: the host now serves
 * ~480 organizations from Epic's published directory over `hostAuth.providers()`,
 * and inlining those here would duplicate a list that already has one source of
 * truth — and bloat every WebContainer mount with data the guest cannot use.
 *
 * This stays as the fallback so the picker is never empty and never blocks on a
 * fetch: if the host is slow, unreachable, or this is a version published by
 * someone else (which cannot call privileged methods at all), the panel still
 * renders exactly what it rendered before the directory existed.
 *
 * `tests/guest-audit.test.ts` pins it against `lib/health/providers.ts`.
 */
export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'ucsf', label: 'UCSF Health', myChartName: 'UCSF MyChart' },
  { id: 'sutter', label: 'Sutter Health', myChartName: 'Sutter My Health Online' },
  { id: 'epic-sandbox', label: 'Epic Sandbox', myChartName: 'Epic test MyChart', sandbox: true },
];

export const DEFAULT_PROVIDER_ID = 'ucsf';
