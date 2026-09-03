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
 * The provider list the connect panel offers. The host holds the real registry
 * and the client id; this is only what the user picks between.
 */
export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'ucsf', label: 'UCSF Health', myChartName: 'UCSF MyChart' },
  { id: 'sutter', label: 'Sutter Health', myChartName: 'Sutter My Health Online' },
  { id: 'epic-sandbox', label: 'Epic Sandbox', myChartName: 'Epic test MyChart', sandbox: true },
];

export const DEFAULT_PROVIDER_ID = 'ucsf';
