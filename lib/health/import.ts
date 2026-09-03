'use client';

import { exportPatientRecord } from './epic';
import { getProvider } from './providers';
import { authorize } from './session';
import { saveRecord } from './storage';
import type { HealthAttachmentSummary, HealthExportDocument } from './types';

/**
 * The full connect round trip, run on the host: authorize, import, encrypt.
 *
 * This is the piece the guest cannot do. The authorization needs a stable,
 * registrable origin; the FHIR requests need Epic's CORS to name that origin;
 * and the resulting key must live somewhere an agent cannot rewrite. All three
 * are true here and none are true in the WebContainer preview.
 */

export interface ImportProgressReport {
  completedSearches: number;
  totalSearches: number;
  resourceCount: number;
}

export interface ConnectParams {
  providerId: string;
  includeAttachments: boolean;
  passphrase: string;
  clientId: string;
  /** Overrides the default SMART scope. Falls back to the provider's, then the default. */
  scope?: string;
  onProgress?: (progress: ImportProgressReport) => void;
}

export async function connectAndImport({
  providerId,
  includeAttachments,
  passphrase,
  clientId,
  scope,
  onProgress,
}: ConnectParams): Promise<HealthExportDocument> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const auth = await authorize(providerId, clientId, scope);

  const attachments: HealthAttachmentSummary[] = [];

  const result = await exportPatientRecord({
    fhirBase: auth.fhirBase,
    patientId: auth.patientId,
    accessToken: auth.accessToken,
    includeAttachments: includeAttachments && provider.capabilities.attachments,
    includePriorAuthorizations: provider.capabilities.priorAuthorizations,
    // Summaries only. The files are listed as a Binary group the user can see
    // and count, but their bytes are not kept: the record crosses the bridge to
    // the guest as one structured-clone payload, and clinical-note binaries do
    // not belong in it. `ExploreView` says so plainly when asked for the text.
    onAttachment: (attachment) => {
      attachments.push({
        key: attachment.key,
        binaryId: attachment.binaryId,
        contentType: attachment.contentType,
        size: attachment.blob.size,
        ...(attachment.sourceDocumentReference
          ? { sourceDocumentReference: attachment.sourceDocumentReference }
          : {}),
        ...(attachment.title ? { title: attachment.title } : {}),
      });
    },
    onProgress: onProgress
      ? (progress) =>
          onProgress({
            completedSearches: progress.completedSearches,
            totalSearches: progress.totalSearches,
            resourceCount: progress.resourceCount,
          })
      : undefined,
  });

  const record: HealthExportDocument = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'YesYou Health',
    source: {
      provider: provider.name,
      fhirBase: auth.fhirBase,
      patientId: auth.patientId,
    },
    purpose: 'Help the patient understand actions taken and documented as part of their care.',
    limitations: [
      'Only the data your provider exposes through its patient-facing FHIR API is included.',
      'This export organizes source records; it is not a clinical judgment.',
    ],
    data: result.data,
    errors: result.errors,
    priorAuthorizations: result.priorAuthorizations,
    ...(attachments.length ? { attachments } : {}),
  };

  await saveRecord(record, passphrase, provider.name);
  return record;
}
