/**
 * The shape of a patient-authorized export, as produced by the FHIR import and
 * consumed by the guest's record explorer.
 *
 * Ported from yesyouhealth's `lib/browser-flow.ts` and `lib/epic.ts`. Kept
 * type-only and dependency-free so both the host subsystem and the guest can
 * describe the same document without sharing an implementation.
 */

export type JsonObject = Record<string, unknown>;

export interface HealthAttachmentSummary {
  key: string;
  binaryId: string;
  contentType: string;
  size: number;
  sourceDocumentReference?: string;
  title?: string;
}

export interface BrowserStorageSummary {
  persistent: boolean;
  quota?: number;
  usage?: number;
}

export interface ExportResult {
  data: Record<string, unknown>;
  errors: Record<string, string>;
  priorAuthorizations: JsonObject[];
}

export interface HealthExportDocument extends ExportResult {
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
  attachments?: HealthAttachmentSummary[];
  browserStorage?: BrowserStorageSummary;
}

export function isHealthExportDocument(value: unknown): value is HealthExportDocument {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.exportedAt === 'string' &&
    typeof record.data === 'object' &&
    record.data !== null
  );
}
