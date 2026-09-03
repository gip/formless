'use client';

import { exportPatientRecord } from './epic';
import { resolveProvider } from './registry';
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
  attachmentCount: number;
  /**
   * The resource type most recently receiving data. Absent until the first page
   * lands, and only ever the *latest* one: searches run four at a time, so this
   * is a sign of life, not a queue position.
   */
  label?: string;
}

/**
 * Content types whose bodies are kept as text on the exported record.
 *
 * Deliberately narrow. `epic.ts` also accepts PDFs, RTF and images, and those
 * stay out: the record crosses the bridge to the guest as one structured-clone
 * payload and is encrypted whole at rest, so binaries do not belong in it. A
 * clinical note's prose is a different thing — it is the richest content in an
 * Epic record and the only part an agent can actually reason about.
 */
const TEXT_ATTACHMENT_TYPES = ['text/html', 'text/plain'];

/** Per-note ceiling. A note past this is truncated, not dropped. */
const MAX_NOTE_TEXT_BYTES = 256 * 1024;

/** Ceiling across the whole import, to bound the bridge payload and the ciphertext. */
const MAX_TOTAL_NOTE_TEXT_BYTES = 8 * 1024 * 1024;

function isTextAttachment(contentType: string): boolean {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return TEXT_ATTACHMENT_TYPES.includes(base);
}

export interface ConnectParams {
  providerId: string;
  includeAttachments: boolean;
  passphrase: string;
  clientId: string;
  /** Overrides the default SMART scope. Falls back to the provider's, then the default. */
  scope?: string;
  /**
   * Fires once the token is in hand and the first FHIR request is about to go
   * out — the moment the download actually starts, which is not the moment the
   * user clicked connect: signing in happens in a popup at the user's own pace.
   *
   * Carries the provider's display name because the guest can no longer look one
   * up: it holds only the curated organizations, not the full directory. The host
   * has already resolved the profile by this point, so it sends what it knows —
   * the same thing `AuthStatus.provider` does for a stored record.
   */
  onImportStart?: (providerName: string) => void;
  onProgress?: (progress: ImportProgressReport) => void;
}

export async function connectAndImport({
  providerId,
  includeAttachments,
  passphrase,
  clientId,
  scope,
  onImportStart,
  onProgress,
}: ConnectParams): Promise<HealthExportDocument> {
  const provider = await resolveProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const auth = await authorize(providerId, clientId, scope);
  onImportStart?.(provider.name);

  const attachments: HealthAttachmentSummary[] = [];
  /** Soft failures from note capture. Folded into `errors.Binary` at the end. */
  const noteErrors: string[] = [];
  let noteTextBytes = 0;
  // `exportPatientRecord` counts resources but does not say which type they came
  // from, and this is the one hook that is told. Recording it here keeps
  // `epic.ts` verbatim (see AGENTS.md) while still giving the progress report
  // something concrete to name.
  let latestLabel: string | undefined;

  const result = await exportPatientRecord({
    fhirBase: auth.fhirBase,
    patientId: auth.patientId,
    accessToken: auth.accessToken,
    includeAttachments: includeAttachments && provider.capabilities.attachments,
    includePriorAuthorizations: provider.capabilities.priorAuthorizations,
    // Summaries, plus the prose of text notes. Binary bodies — PDFs, images,
    // RTF — are still discarded: the record crosses the bridge as one
    // structured-clone payload and is encrypted whole, and those do not belong
    // in it. Note text does, and is what `read_health_records` reads back.
    //
    // Throwing from here would abort the entire import (`epic.ts` wraps a sink
    // throw in `ImportSinkError` and rethrows it), so a failed read degrades to
    // a recorded message and an attachment with no text.
    onAttachment: async (attachment) => {
      let noteText: string | undefined;
      if (isTextAttachment(attachment.contentType)) {
        if (noteTextBytes >= MAX_TOTAL_NOTE_TEXT_BYTES) {
          noteErrors.push(
            `Note text reached the ${
              MAX_TOTAL_NOTE_TEXT_BYTES / 1024 / 1024
            } MB total limit. Later notes were stored without their text.`,
          );
        } else {
          try {
            const body = await attachment.blob.text();
            noteText = body.length > MAX_NOTE_TEXT_BYTES ? body.slice(0, MAX_NOTE_TEXT_BYTES) : body;
            if (noteText.length < body.length) {
              noteErrors.push(
                `Binary/${attachment.binaryId} was longer than the ${
                  MAX_NOTE_TEXT_BYTES / 1024
                } KB per-note limit and its text was truncated.`,
              );
            }
            noteTextBytes += noteText.length;
          } catch {
            noteErrors.push(`Could not read the text of Binary/${attachment.binaryId}.`);
          }
        }
      }
      attachments.push({
        key: attachment.key,
        binaryId: attachment.binaryId,
        contentType: attachment.contentType,
        size: attachment.blob.size,
        ...(attachment.sourceDocumentReference
          ? { sourceDocumentReference: attachment.sourceDocumentReference }
          : {}),
        ...(attachment.title ? { title: attachment.title } : {}),
        ...(noteText ? { text: noteText } : {}),
      });
    },
    // Sink for the label only; the record itself still comes back as the result.
    // Throwing from here would abort the whole import, so it must not.
    onResources: (group) => { latestLabel = group; },
    onProgress: onProgress
      ? (progress) =>
          onProgress({
            completedSearches: progress.completedSearches,
            totalSearches: progress.totalSearches,
            resourceCount: progress.resourceCount,
            attachmentCount: progress.attachmentCount,
            ...(latestLabel ? { label: latestLabel } : {}),
          })
      : undefined,
  });

  const record: HealthExportDocument = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'Formless Health',
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
    errors: noteErrors.length
      ? {
        ...result.errors,
        Binary: [result.errors.Binary, ...new Set(noteErrors)].filter(Boolean).join(' '),
      }
      : result.errors,
    priorAuthorizations: result.priorAuthorizations,
    ...(attachments.length ? { attachments } : {}),
  };

  await saveRecord(record, passphrase, provider.name);
  return record;
}
