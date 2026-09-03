/**
 * The host's read model over an imported health record.
 *
 * A real Epic export is thousands of resources across twenty-odd types — the
 * de-identified fixture alone is 1,411 resources and 4.5MB. No agent can be
 * handed that whole, so this module turns one `HealthExportDocument` into three
 * bounded views: a whole-record summary, a paged per-item listing, and a reader
 * for specific resources.
 *
 * It deliberately duplicates the field extraction in
 * `guest/src/components/explore-data.ts` rather than importing it. That file
 * lives under `src/components/**`, which `project-policy.ts` marks editable —
 * it is code an agent, or a stranger who published a version, is allowed to
 * rewrite. A host tool that read the user's own record through guest-editable
 * code would hand the trust boundary away. This is the same deliberate
 * duplication as `BRIDGE_PROTOCOL`: change both together when the rendering of
 * a resource type changes.
 *
 * Kept free of DOM and of React so it runs under the node test environment,
 * which is why `htmlToPlainText` here is a tokenizer rather than the guest's
 * `DOMParser` version in `TextModal.tsx`.
 */

import type { HealthExportDocument, JsonObject } from './types';

export type RecordSource = 'connected' | 'sample' | 'none';

export interface RenderedField {
  label: string;
  value: string;
}

/** One item in the record, as `list_health_records` reports it. */
export interface RecordEntry {
  /** `Group/id` — the canonical handle, accepted back by `readEntries`. */
  ref: string;
  group: string;
  label: string;
  title: string;
  date?: string;
  status?: string;
  summary?: string;
  /** True when `readEntries(..., 'text')` can return prose for this entry. */
  hasText: boolean;
}

export interface GroupSummary {
  key: string;
  label: string;
  count: number;
  earliest?: string;
  latest?: string;
  statuses: Record<string, number>;
  /** Observation arrives as three import variants collapsed under one key. */
  categories?: Record<string, number>;
  commonTitles: string[];
  withText?: number;
}

export interface RecordSummary {
  exportedAt: string;
  exportedBy: string;
  purpose: string;
  limitations: string[];
  provenance: { provider: string; fhirBase: string; patientId: string };
  patient?: { name?: string; birthDate?: string; gender?: string };
  totals: {
    resources: number;
    groups: number;
    attachments: number;
    attachmentBytes: number;
    notesWithText: number;
  };
  groups: GroupSummary[];
  importErrors: { group: string; message: string }[];
}

export interface ListFilter {
  group?: string;
  query?: string;
  from?: string;
  to?: string;
  status?: string;
  limit?: number;
  offset?: number;
  sort?: 'date_desc' | 'date_asc' | 'group';
}

export interface RecordPage {
  total: number;
  returned: number;
  offset: number;
  nextOffset: number | null;
  entries: RecordEntry[];
  truncated: boolean;
  guidance?: string;
}

export type ReadFormat = 'fields' | 'fhir' | 'text';

export interface ReadItem {
  ref: string;
  group: string;
  label: string;
  title: string;
  date?: string;
  status?: string;
  fields?: RenderedField[];
  fhir?: JsonObject;
  text?: string;
  textTruncated?: boolean;
  totalChars?: number;
  /** Why the requested format could not be fully answered. */
  note?: string;
}

export interface ReadResult {
  items: ReadItem[];
  /** Refs that matched nothing, or matched ambiguously. */
  missing: string[];
  truncated: boolean;
  guidance?: string;
}

/**
 * Ceiling on one tool result. A hundred Observations serialize to roughly
 * 290KB of raw FHIR, which is not a useful thing to put in front of a model —
 * the builders stop short of this and say so rather than cutting silently.
 */
export const MAX_TOOL_RESULT_BYTES = 120_000;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const MAX_READ_REFS = 20;
export const DEFAULT_TEXT_CHARS = 20_000;
export const MAX_TEXT_CHARS = 100_000;

const MAX_COMMON_TITLES = 5;

const GROUP_LABELS: Record<string, string> = {
  Patient: 'Patient',
  AllergyIntolerance: 'Allergies',
  Appointment: 'Appointments',
  CarePlan: 'Care plans',
  CareTeam: 'Care team',
  Condition: 'Conditions',
  Coverage: 'Coverage',
  DeviceUseStatement: 'Devices',
  DiagnosticReport: 'Diagnostic reports',
  DocumentReference: 'Documents',
  Encounter: 'Encounters',
  FamilyMemberHistory: 'Family history',
  Goal: 'Goals',
  Immunization: 'Immunizations',
  MedicationDispense: 'Medication fills',
  MedicationRequest: 'Medications',
  Observation: 'Observations',
  Procedure: 'Procedures',
  QuestionnaireResponse: 'Questionnaires',
  ServiceRequest: 'Orders',
  PriorAuthorization: 'Prior authorizations',
  Binary: 'Clinical-note files',
};

const GROUP_ORDER = Object.keys(GROUP_LABELS);

/** The patient-facing name for a FHIR resource type. */
export function groupLabel(key: string): string {
  return GROUP_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asObjects(value: unknown): JsonObject[] {
  if (Array.isArray(value)) {
    return value.map(asObject).filter((item): item is JsonObject => Boolean(item));
  }
  const object = asObject(value);
  return object ? [object] : [];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function codeable(value: unknown): string | undefined {
  const object = asObject(value);
  if (!object) return text(value);
  const direct = text(object.text) ?? text(object.display);
  if (direct) return direct;
  const coding = Array.isArray(object.coding) ? asObject(object.coding[0]) : undefined;
  return text(coding?.display) ?? text(coding?.code);
}

function reference(value: unknown): string | undefined {
  const object = asObject(value);
  return text(object?.display) ?? text(object?.reference) ?? text(value);
}

function periodStart(value: unknown): string | undefined {
  return text(asObject(value)?.start);
}

function period(value: unknown): string | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  const start = text(object.start);
  const end = text(object.end);
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

function quantity(value: unknown): string | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  const amount = text(object.value);
  const unit = text(object.unit) ?? text(object.code);
  return amount ? `${amount}${unit ? ` ${unit}` : ''}` : undefined;
}

function humanName(value: unknown): string | undefined {
  const object = Array.isArray(value) ? asObject(value[0]) : asObject(value);
  if (!object) return undefined;
  const direct = text(object.text);
  if (direct) return direct;
  const given = Array.isArray(object.given) ? object.given.map(text).filter(Boolean).join(' ') : '';
  const family = text(object.family) ?? '';
  return [given, family].filter(Boolean).join(' ') || undefined;
}

function joinValues(
  value: unknown,
  formatter: (item: unknown) => string | undefined = codeable,
): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  const formatted = values.map(formatter).filter((item): item is string => Boolean(item));
  return formatted.length ? formatted.join(', ') : undefined;
}

function add(fields: RenderedField[], label: string, value: string | undefined): void {
  if (value) fields.push({ label, value });
}

function fileSize(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function compactIdentifier(value: unknown): string | undefined {
  const identifier = text(value);
  if (!identifier || identifier.length <= 12) return identifier;
  return `${identifier.slice(0, 4)}...${identifier.slice(-4)}`;
}

/**
 * The one date that best places a resource in time.
 *
 * Sorting and date filtering are the whole point of the listing tool, and FHIR
 * spreads that date across a different field on almost every resource type. The
 * generic fallback catches types this list does not name.
 */
export function primaryDate(resource: JsonObject): string | undefined {
  switch (resource.resourceType) {
    case 'Observation':
      return text(resource.effectiveDateTime)
        ?? periodStart(resource.effectivePeriod)
        ?? text(resource.issued);
    case 'Condition':
      return text(resource.onsetDateTime)
        ?? periodStart(resource.onsetPeriod)
        ?? text(resource.recordedDate);
    case 'Encounter':
      return periodStart(resource.period);
    case 'Procedure':
      return text(resource.performedDateTime) ?? periodStart(resource.performedPeriod);
    case 'Immunization':
      return text(resource.occurrenceDateTime) ?? text(resource.occurrenceString);
    case 'MedicationRequest':
      return text(resource.authoredOn);
    case 'MedicationDispense':
      return text(resource.whenHandedOver) ?? text(resource.whenPrepared);
    case 'DiagnosticReport':
      return text(resource.effectiveDateTime)
        ?? periodStart(resource.effectivePeriod)
        ?? text(resource.issued);
    case 'DocumentReference':
      return text(resource.date);
    case 'Appointment':
      return text(resource.start);
    case 'CarePlan':
    case 'CareTeam':
    case 'Coverage':
      return periodStart(resource.period);
    case 'Goal':
      return text(resource.startDate);
    case 'ServiceRequest':
      return text(resource.authoredOn)
        ?? text(resource.occurrenceDateTime)
        ?? periodStart(resource.occurrencePeriod);
    case 'QuestionnaireResponse':
      return text(resource.authored);
    case 'AllergyIntolerance':
      return text(resource.recordedDate);
    case 'ExplanationOfBenefit':
      return text(resource.created);
    case 'DeviceUseStatement':
      return text(resource.timingDateTime)
        ?? periodStart(resource.timingPeriod)
        ?? text(resource.recordedOn);
    default:
      return text(resource.date)
        ?? text(resource.authoredOn)
        ?? text(resource.created)
        ?? text(resource.recordedDate)
        ?? text(resource.issued);
  }
}

export function resourceTitle(resource: JsonObject, fallbackLabel: string): string {
  switch (resource.resourceType) {
    case 'Patient':
      return humanName(resource.name) ?? fallbackLabel;
    case 'MedicationRequest':
      return codeable(resource.medicationCodeableConcept)
        ?? reference(resource.medicationReference)
        ?? fallbackLabel;
    case 'Immunization':
      return codeable(resource.vaccineCode) ?? fallbackLabel;
    case 'Goal':
      return codeable(resource.description) ?? fallbackLabel;
    case 'CarePlan':
      return text(resource.title) ?? fallbackLabel;
    case 'DocumentReference':
      return text(resource.description) ?? codeable(resource.type) ?? fallbackLabel;
    case 'Appointment':
      return codeable(resource.appointmentType) ?? joinValues(resource.serviceType) ?? fallbackLabel;
    case 'MedicationDispense':
      return codeable(resource.medicationCodeableConcept)
        ?? reference(resource.medicationReference)
        ?? fallbackLabel;
    case 'ServiceRequest':
      return codeable(resource.code) ?? fallbackLabel;
    case 'Binary':
      return text(resource.title) ?? compactIdentifier(resource.id) ?? fallbackLabel;
    default:
      return codeable(resource.code) ?? codeable(resource.type) ?? fallbackLabel;
  }
}

function commonFields(resource: JsonObject): RenderedField[] {
  const fields: RenderedField[] = [];
  add(fields, 'Status', text(resource.status));
  add(fields, 'Identifier', text(resource.id));
  return fields;
}

export function renderedFields(resource: JsonObject): RenderedField[] {
  const fields = commonFields(resource);
  switch (resource.resourceType) {
    case 'Patient': {
      add(fields, 'Name', humanName(resource.name));
      add(fields, 'Date of birth', text(resource.birthDate));
      add(fields, 'Gender', text(resource.gender));
      add(fields, 'Contact', joinValues(resource.telecom, (item) => text(asObject(item)?.value)));
      add(fields, 'Address', joinValues(resource.address, (item) => {
        const address = asObject(item);
        if (!address) return undefined;
        const lines = Array.isArray(address.line) ? address.line.map(text).filter(Boolean) : [];
        return [...lines, text(address.city), text(address.state), text(address.postalCode)]
          .filter(Boolean)
          .join(', ');
      }));
      break;
    }
    case 'AllergyIntolerance': {
      add(fields, 'Allergy or intolerance', codeable(resource.code));
      add(fields, 'Clinical status', codeable(resource.clinicalStatus));
      add(fields, 'Verification', codeable(resource.verificationStatus));
      add(fields, 'Criticality', text(resource.criticality));
      add(fields, 'Recorded', text(resource.recordedDate));
      const reactions = Array.isArray(resource.reaction)
        ? resource.reaction.flatMap((item) => {
          const reaction = asObject(item);
          return Array.isArray(reaction?.manifestation) ? reaction.manifestation : [];
        })
        : [];
      add(fields, 'Reactions', joinValues(reactions));
      break;
    }
    case 'Condition': {
      add(fields, 'Condition', codeable(resource.code));
      add(fields, 'Clinical status', codeable(resource.clinicalStatus));
      add(fields, 'Verification', codeable(resource.verificationStatus));
      add(fields, 'Onset', text(resource.onsetDateTime) ?? period(resource.onsetPeriod) ?? text(resource.onsetString));
      add(fields, 'Recorded', text(resource.recordedDate));
      break;
    }
    case 'Observation': {
      add(fields, 'Observation', codeable(resource.code));
      add(fields, 'Value', quantity(resource.valueQuantity)
        ?? codeable(resource.valueCodeableConcept)
        ?? text(resource.valueString)
        ?? text(resource.valueInteger)
        ?? text(resource.valueBoolean));
      add(fields, 'Effective', text(resource.effectiveDateTime) ?? period(resource.effectivePeriod));
      add(fields, 'Category', joinValues(resource.category));
      add(fields, 'Interpretation', joinValues(resource.interpretation));
      add(fields, 'Components', joinValues(resource.component, (item) => {
        const component = asObject(item);
        if (!component) return undefined;
        const name = codeable(component.code);
        const value = quantity(component.valueQuantity)
          ?? codeable(component.valueCodeableConcept)
          ?? text(component.valueString);
        return [name, value].filter(Boolean).join(': ') || undefined;
      }));
      add(fields, 'Reference range', joinValues(resource.referenceRange, (item) => {
        const range = asObject(item);
        if (!range) return undefined;
        const low = quantity(range.low);
        const high = quantity(range.high);
        return text(range.text) ?? ([low, high].filter(Boolean).join(' – ') || undefined);
      }));
      add(fields, 'Notes', joinValues(resource.note, (item) => text(asObject(item)?.text)));
      break;
    }
    case 'MedicationRequest': {
      add(fields, 'Medication', codeable(resource.medicationCodeableConcept) ?? reference(resource.medicationReference));
      add(fields, 'Intent', text(resource.intent));
      add(fields, 'Authored', text(resource.authoredOn));
      add(fields, 'Dosage', joinValues(resource.dosageInstruction, (item) => text(asObject(item)?.text)));
      break;
    }
    case 'Encounter': {
      add(fields, 'Type', joinValues(resource.type));
      add(fields, 'Class', codeable(resource.class));
      add(fields, 'Period', period(resource.period));
      add(fields, 'Reason', joinValues(resource.reasonCode));
      add(fields, 'Location', joinValues(resource.location, (item) => reference(asObject(item)?.location)));
      break;
    }
    case 'Procedure': {
      add(fields, 'Procedure', codeable(resource.code));
      add(fields, 'Performed', text(resource.performedDateTime) ?? period(resource.performedPeriod));
      add(fields, 'Reason', joinValues(resource.reasonCode));
      add(fields, 'Outcome', codeable(resource.outcome));
      break;
    }
    case 'Immunization': {
      add(fields, 'Vaccine', codeable(resource.vaccineCode));
      add(fields, 'Date', text(resource.occurrenceDateTime) ?? text(resource.occurrenceString));
      add(fields, 'Lot number', text(resource.lotNumber));
      add(fields, 'Site', codeable(resource.site));
      break;
    }
    case 'DiagnosticReport': {
      add(fields, 'Report', codeable(resource.code));
      add(fields, 'Effective', text(resource.effectiveDateTime) ?? period(resource.effectivePeriod));
      add(fields, 'Issued', text(resource.issued));
      add(fields, 'Conclusion', text(resource.conclusion));
      add(fields, 'Results', joinValues(resource.result, reference));
      add(fields, 'Presented files', joinValues(resource.presentedForm, (item) => {
        const attachment = asObject(item);
        return text(attachment?.title) ?? text(attachment?.contentType) ?? text(attachment?.url);
      }));
      break;
    }
    case 'DocumentReference': {
      add(fields, 'Document type', codeable(resource.type));
      add(fields, 'Category', joinValues(resource.category));
      add(fields, 'Date', text(resource.date));
      add(fields, 'Description', text(resource.description));
      add(fields, 'Author', joinValues(resource.author, reference));
      break;
    }
    case 'Goal': {
      add(fields, 'Goal', codeable(resource.description));
      add(fields, 'Lifecycle status', text(resource.lifecycleStatus));
      add(fields, 'Achievement', codeable(resource.achievementStatus));
      add(fields, 'Start', text(resource.startDate) ?? codeable(resource.startCodeableConcept));
      break;
    }
    case 'CarePlan': {
      add(fields, 'Title', text(resource.title));
      add(fields, 'Intent', text(resource.intent));
      add(fields, 'Period', period(resource.period));
      add(fields, 'Description', text(resource.description));
      add(fields, 'Category', joinValues(resource.category));
      add(fields, 'Addresses', joinValues(resource.addresses, reference));
      add(fields, 'Goals', joinValues(resource.goal, reference));
      add(fields, 'Activities', joinValues(resource.activity, (item) => {
        const detail = asObject(asObject(item)?.detail);
        return codeable(detail?.code) ?? text(detail?.description) ?? reference(asObject(item)?.reference);
      }));
      add(fields, 'Notes', joinValues(resource.note, (item) => text(asObject(item)?.text)));
      break;
    }
    case 'Coverage': {
      add(fields, 'Coverage type', codeable(resource.type));
      add(fields, 'Subscriber', reference(resource.subscriber));
      add(fields, 'Beneficiary', reference(resource.beneficiary));
      add(fields, 'Period', period(resource.period));
      add(fields, 'Payor', joinValues(resource.payor, reference));
      break;
    }
    case 'ExplanationOfBenefit': {
      add(fields, 'Type', codeable(resource.type));
      add(fields, 'Use', text(resource.use));
      add(fields, 'Created', text(resource.created));
      add(fields, 'Insurer', reference(resource.insurer));
      add(fields, 'Outcome', text(resource.outcome));
      break;
    }
    case 'Appointment': {
      add(fields, 'Appointment type', codeable(resource.appointmentType));
      add(fields, 'Service', joinValues(resource.serviceType));
      add(fields, 'Start', text(resource.start));
      add(fields, 'End', text(resource.end));
      add(fields, 'Participants', joinValues(resource.participant, (item) => reference(asObject(item)?.actor)));
      break;
    }
    case 'CareTeam': {
      add(fields, 'Category', joinValues(resource.category));
      add(fields, 'Period', period(resource.period));
      add(fields, 'Members', joinValues(resource.participant, (item) => {
        const participant = asObject(item);
        const role = joinValues(participant?.role);
        const member = reference(participant?.member);
        return [member, role].filter(Boolean).join(' — ') || undefined;
      }));
      break;
    }
    case 'DeviceUseStatement': {
      add(fields, 'Device', reference(resource.device));
      add(fields, 'Timing', text(resource.timingDateTime) ?? period(resource.timingPeriod));
      add(fields, 'Reason', joinValues(resource.reasonCode));
      break;
    }
    case 'FamilyMemberHistory': {
      add(fields, 'Relationship', codeable(resource.relationship));
      add(fields, 'Name', text(resource.name));
      add(fields, 'Sex', codeable(resource.sex));
      add(fields, 'Conditions', joinValues(resource.condition, (item) => codeable(asObject(item)?.code)));
      add(fields, 'Notes', joinValues(resource.note, (item) => text(asObject(item)?.text)));
      break;
    }
    case 'MedicationDispense': {
      add(fields, 'Medication', codeable(resource.medicationCodeableConcept)
        ?? reference(resource.medicationReference));
      add(fields, 'Handed over', text(resource.whenHandedOver));
      add(fields, 'Prepared', text(resource.whenPrepared));
      add(fields, 'Quantity', quantity(resource.quantity));
      add(fields, 'Days supplied', quantity(resource.daysSupply));
      add(fields, 'Dosage', joinValues(resource.dosageInstruction, (item) => text(asObject(item)?.text)));
      break;
    }
    case 'QuestionnaireResponse': {
      add(fields, 'Questionnaire', reference(resource.questionnaire));
      add(fields, 'Authored', text(resource.authored));
      add(fields, 'Encounter', reference(resource.encounter));
      add(fields, 'Answers', joinValues(resource.item, (item) => {
        const question = asObject(item);
        const answers = Array.isArray(question?.answer)
          ? question.answer.map((answer) => {
            const value = asObject(answer);
            return text(value?.valueString)
              ?? text(value?.valueBoolean)
              ?? text(value?.valueInteger)
              ?? codeable(value?.valueCoding)
              ?? quantity(value?.valueQuantity);
          }).filter(Boolean).join(', ')
          : undefined;
        return [text(question?.text), answers].filter(Boolean).join(': ') || undefined;
      }));
      break;
    }
    case 'ServiceRequest': {
      add(fields, 'Order', codeable(resource.code));
      add(fields, 'Intent', text(resource.intent));
      add(fields, 'Authored', text(resource.authoredOn));
      add(fields, 'Occurrence', text(resource.occurrenceDateTime) ?? period(resource.occurrencePeriod));
      add(fields, 'Requester', reference(resource.requester));
      add(fields, 'Reason', joinValues(resource.reasonCode));
      break;
    }
    case 'Binary': {
      add(fields, 'File name', text(resource.title));
      add(fields, 'Content type', text(resource.contentType));
      add(fields, 'File size', fileSize(resource.size));
      add(fields, 'Source document', text(resource.sourceDocumentReference));
      break;
    }
    default: {
      add(fields, 'Code', codeable(resource.code));
      add(fields, 'Category', joinValues(resource.category));
      add(fields, 'Date', text(resource.date) ?? text(resource.authoredOn) ?? text(resource.created));
    }
  }
  return fields;
}

/* -------------------------------------------------------------------------- */
/* Note text                                                                  */
/* -------------------------------------------------------------------------- */

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Strips markup so a clinical note reads as prose.
 *
 * The guest's equivalent in `TextModal.tsx` uses `DOMParser`; this one cannot,
 * because the unit suite runs under `environment: 'node'` and because the host
 * should not need a document to answer a tool call.
 */
export function htmlToPlainText(content: string): string {
  const withoutScripts = content.replace(
    /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|blockquote)\s*>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|section|article|table|blockquote)\b[^>]*>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ''))
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Decodes a FHIR `Binary.data` payload. `atob` yields latin1, so the bytes go
 * back through `TextDecoder` — a UTF-8 note otherwise arrives mojibaked.
 */
function decodeBase64Text(value: unknown): string | undefined {
  const encoded = text(value);
  if (!encoded) return undefined;
  try {
    const binary = atob(encoded.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

interface IndexedEntry extends RecordEntry {
  id: string;
  resource: JsonObject;
  /** Raw note body, before markup stripping. Only ever set for Binary entries. */
  rawText?: string;
  contentType?: string;
  searchText: string;
}

interface RecordIndex {
  entries: IndexedEntry[];
  byRef: Map<string, IndexedEntry>;
  byId: Map<string, IndexedEntry[]>;
  groups: GroupSummary[];
  totalResources: number;
  notesWithText: number;
}

const indexCache = new WeakMap<object, RecordIndex>();

/** The one-line gloss under a title: the first substantive rendered fields. */
function summaryLine(fields: RenderedField[]): string | undefined {
  const substantive = fields.filter(
    (field) => field.label !== 'Status' && field.label !== 'Identifier',
  );
  if (!substantive.length) return undefined;
  return substantive.slice(0, 2).map((field) => `${field.label}: ${field.value}`).join(' · ');
}

/**
 * Assembles the Binary group.
 *
 * Two sources have to be reconciled. `attachments` carries the metadata the
 * import kept (content type, size, source document) and, since note capture,
 * the prose itself. `data.Binary` exists only in records exported by the
 * original yesyouhealth pipeline — the checked-in fixture is one — and carries
 * the body as base64. Merging by id means the fixture and a freshly imported
 * record both answer `format: 'text'`.
 */
function binaryEntries(healthExport: HealthExportDocument): JsonObject[] {
  const bodies = new Map<string, JsonObject>();
  for (const resource of asObjects(healthExport.data.Binary)) {
    const id = text(resource.id);
    if (id) bodies.set(id, resource);
  }

  const merged: JsonObject[] = [];
  const seen = new Set<string>();
  for (const attachment of healthExport.attachments ?? []) {
    seen.add(attachment.binaryId);
    const body = bodies.get(attachment.binaryId);
    merged.push({
      resourceType: 'Binary',
      id: attachment.binaryId,
      key: attachment.key,
      contentType: attachment.contentType,
      size: attachment.size,
      ...(attachment.sourceDocumentReference
        ? { sourceDocumentReference: attachment.sourceDocumentReference }
        : {}),
      ...(attachment.title ? { title: attachment.title } : {}),
      ...(attachment.text !== undefined
        ? { text: attachment.text }
        : body
          ? { data: body.data }
          : {}),
    });
  }
  // A body with no attachment summary should still be reachable rather than
  // silently dropped.
  for (const [id, body] of bodies) {
    if (seen.has(id)) continue;
    merged.push({ ...body, id });
  }
  return merged;
}

function groupsOf(healthExport: HealthExportDocument): { key: string; resources: JsonObject[] }[] {
  const groups = new Map<string, JsonObject[]>();
  for (const [key, value] of Object.entries(healthExport.data)) {
    if (key === 'Binary') continue;
    const resources = asObjects(value);
    if (resources.length) groups.set(key, resources);
  }
  if (healthExport.priorAuthorizations.length) {
    groups.set('PriorAuthorization', healthExport.priorAuthorizations);
  }
  const binaries = binaryEntries(healthExport);
  if (binaries.length) groups.set('Binary', binaries);

  return [...groups.entries()]
    .map(([key, resources]) => ({ key, resources }))
    .sort((left, right) => {
      const leftIndex = GROUP_ORDER.indexOf(left.key);
      const rightIndex = GROUP_ORDER.indexOf(right.key);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    });
}

function buildIndex(healthExport: HealthExportDocument): RecordIndex {
  const entries: IndexedEntry[] = [];
  const byRef = new Map<string, IndexedEntry>();
  const byId = new Map<string, IndexedEntry[]>();
  const groups: GroupSummary[] = [];
  let notesWithText = 0;

  for (const { key, resources } of groupsOf(healthExport)) {
    const label = groupLabel(key);
    const statuses: Record<string, number> = {};
    const categories: Record<string, number> = {};
    const titleCounts = new Map<string, number>();
    let earliest: string | undefined;
    let latest: string | undefined;
    let withText = 0;

    resources.forEach((resource, position) => {
      const id = text(resource.id) ?? `${position}`;
      const ref = `${key}/${id}`;
      const fields = renderedFields(resource);
      const title = resourceTitle(resource, `${label} item`);
      const date = primaryDate(resource);
      const status = text(resource.status);
      const summary = summaryLine(fields);

      const rawText = key === 'Binary'
        ? text(resource.text) ?? decodeBase64Text(resource.data)
        : undefined;
      if (rawText) {
        withText += 1;
        notesWithText += 1;
      }

      const entry: IndexedEntry = {
        ref,
        group: key,
        label,
        title,
        ...(date ? { date } : {}),
        ...(status ? { status } : {}),
        ...(summary ? { summary } : {}),
        hasText: Boolean(rawText),
        id,
        resource,
        ...(rawText ? { rawText } : {}),
        ...(key === 'Binary' ? { contentType: text(resource.contentType) ?? 'text/plain' } : {}),
        searchText: `${title} ${summary ?? ''}`.toLowerCase(),
      };

      entries.push(entry);
      byRef.set(ref, entry);
      const sameId = byId.get(id);
      if (sameId) sameId.push(entry);
      else byId.set(id, [entry]);

      if (status) statuses[status] = (statuses[status] ?? 0) + 1;
      const category = joinValues(resource.category);
      if (category) categories[category] = (categories[category] ?? 0) + 1;
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      if (date) {
        if (!earliest || date < earliest) earliest = date;
        if (!latest || date > latest) latest = date;
      }
    });

    const commonTitles = [...titleCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_COMMON_TITLES)
      .map(([title]) => title);

    groups.push({
      key,
      label,
      count: resources.length,
      ...(earliest ? { earliest } : {}),
      ...(latest ? { latest } : {}),
      statuses,
      ...(Object.keys(categories).length ? { categories } : {}),
      commonTitles,
      ...(withText ? { withText } : {}),
    });
  }

  return { entries, byRef, byId, groups, totalResources: entries.length, notesWithText };
}

function indexOf(healthExport: HealthExportDocument): RecordIndex {
  const cached = indexCache.get(healthExport);
  if (cached) return cached;
  const built = buildIndex(healthExport);
  indexCache.set(healthExport, built);
  return built;
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

export function summarizeRecord(healthExport: HealthExportDocument): RecordSummary {
  const index = indexOf(healthExport);
  const patient = asObject(healthExport.data.Patient)
    ?? asObjects(healthExport.data.Patient)[0];

  const attachments = healthExport.attachments ?? [];
  const attachmentBytes = attachments.reduce((total, item) => total + (item.size ?? 0), 0);

  return {
    exportedAt: healthExport.exportedAt,
    exportedBy: healthExport.exportedBy,
    purpose: healthExport.purpose,
    limitations: healthExport.limitations,
    provenance: healthExport.source,
    ...(patient
      ? {
        patient: {
          ...(humanName(patient.name) ? { name: humanName(patient.name) } : {}),
          ...(text(patient.birthDate) ? { birthDate: text(patient.birthDate) } : {}),
          ...(text(patient.gender) ? { gender: text(patient.gender) } : {}),
        },
      }
      : {}),
    totals: {
      resources: index.totalResources,
      groups: index.groups.length,
      attachments: attachments.length,
      attachmentBytes,
      notesWithText: index.notesWithText,
    },
    groups: index.groups,
    importErrors: Object.entries(healthExport.errors).map(([group, message]) => ({
      group,
      message,
    })),
  };
}

/** Accepts a group by key (`Observation`) or by patient-facing label. */
function matchesGroup(entry: IndexedEntry, group: string): boolean {
  const wanted = group.trim().toLowerCase();
  return entry.group.toLowerCase() === wanted || entry.label.toLowerCase() === wanted;
}

/**
 * ISO-8601 sorts lexicographically the same way it sorts chronologically, so a
 * string comparison is a correct date-bound check and needs no parsing. A bare
 * `YYYY-MM-DD` bound means the whole of that day at both ends, which is why the
 * entry's timestamp is trimmed to match the bound's precision.
 */
function withinBound(date: string | undefined, bound: string, comparison: 'gte' | 'lte'): boolean {
  if (date === undefined) return false;
  const value = bound.length <= 10 ? date.slice(0, 10) : date;
  return comparison === 'gte' ? value >= bound : value <= bound;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function listEntries(
  healthExport: HealthExportDocument,
  filter: ListFilter = {},
): RecordPage {
  const index = indexOf(healthExport);
  const limit = clamp(filter.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const offset = clamp(filter.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const query = filter.query?.trim().toLowerCase();
  const status = filter.status?.trim().toLowerCase();

  let matched = index.entries;
  if (filter.group) matched = matched.filter((entry) => matchesGroup(entry, filter.group as string));
  if (query) matched = matched.filter((entry) => entry.searchText.includes(query));
  if (status) matched = matched.filter((entry) => entry.status?.toLowerCase() === status);
  if (filter.from) matched = matched.filter((entry) => withinBound(entry.date, filter.from as string, 'gte'));
  if (filter.to) matched = matched.filter((entry) => withinBound(entry.date, filter.to as string, 'lte'));

  const sort = filter.sort ?? 'date_desc';
  if (sort !== 'group') {
    // `date_desc` puts the newest first, so a later date must sort earlier:
    // when the left date is the smaller one it belongs *after* the right.
    const direction = sort === 'date_asc' ? -1 : 1;
    matched = [...matched].sort((left, right) => {
      // Undated resources sort last whichever way the dated ones run: they are
      // the least useful answer to "what happened recently".
      if (!left.date && !right.date) return left.ref.localeCompare(right.ref);
      if (!left.date) return 1;
      if (!right.date) return -1;
      if (left.date === right.date) return left.ref.localeCompare(right.ref);
      return left.date < right.date ? direction : -direction;
    });
  }

  const page = matched.slice(offset, offset + limit);
  const entries: RecordEntry[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of page) {
    const projected: RecordEntry = {
      ref: entry.ref,
      group: entry.group,
      label: entry.label,
      title: entry.title,
      ...(entry.date ? { date: entry.date } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      hasText: entry.hasText,
    };
    bytes += JSON.stringify(projected).length;
    if (bytes > MAX_TOOL_RESULT_BYTES && entries.length) {
      truncated = true;
      break;
    }
    entries.push(projected);
  }

  const consumed = offset + entries.length;
  return {
    total: matched.length,
    returned: entries.length,
    offset,
    nextOffset: consumed < matched.length ? consumed : null,
    entries,
    truncated,
    ...(truncated
      ? { guidance: 'The result hit its size limit. Ask for a smaller limit or narrow with group, query, or a date range.' }
      : {}),
  };
}

/** Resolves `Group/id`, or a bare id when exactly one resource carries it. */
function resolve(index: RecordIndex, ref: string): IndexedEntry | undefined {
  const trimmed = ref.trim();
  const direct = index.byRef.get(trimmed);
  if (direct) return direct;
  const candidates = index.byId.get(trimmed);
  if (candidates?.length === 1) return candidates[0];
  // `Observation/abc` where the group is spelled as the resource type but the
  // import filed it under a different label.
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const id = trimmed.slice(slash + 1);
    const byBareId = index.byId.get(id);
    if (byBareId?.length === 1) return byBareId[0];
  }
  return undefined;
}

export interface ReadOptions {
  textOffset?: number;
  maxChars?: number;
}

export function readEntries(
  healthExport: HealthExportDocument,
  refs: readonly string[],
  format: ReadFormat = 'fields',
  options: ReadOptions = {},
): ReadResult {
  const index = indexOf(healthExport);
  const items: ReadItem[] = [];
  const missing: string[] = [];
  let bytes = 0;
  let truncated = false;

  for (const ref of refs.slice(0, MAX_READ_REFS)) {
    const entry = resolve(index, ref);
    if (!entry) {
      missing.push(ref);
      continue;
    }

    const item: ReadItem = {
      ref: entry.ref,
      group: entry.group,
      label: entry.label,
      title: entry.title,
      ...(entry.date ? { date: entry.date } : {}),
      ...(entry.status ? { status: entry.status } : {}),
    };

    if (format === 'fields') {
      item.fields = renderedFields(entry.resource);
    } else if (format === 'fhir') {
      if (entry.group === 'Binary') {
        // The base64 body would dwarf everything else in the result and is not
        // readable as JSON anyway.
        item.fhir = Object.fromEntries(
          Object.entries(entry.resource).filter(([key]) => key !== 'data' && key !== 'text'),
        );
        item.note = entry.hasText
          ? 'The note body is omitted here. Read it with format: "text".'
          : 'This record does not carry the body of this file.';
      } else {
        item.fhir = entry.resource;
      }
    } else {
      const raw = entry.rawText;
      if (!raw) {
        item.note = entry.group === 'Binary'
          ? 'The body of this file is not stored in this record.'
          : 'Only clinical-note files carry text. Use format "fields" or "fhir" for this resource.';
      } else {
        const prose = (entry.contentType ?? '').includes('html') ? htmlToPlainText(raw) : raw;
        const start = clamp(options.textOffset, 0, 0, Number.MAX_SAFE_INTEGER);
        const span = clamp(options.maxChars, DEFAULT_TEXT_CHARS, 1, MAX_TEXT_CHARS);
        const slice = prose.slice(start, start + span);
        item.text = slice;
        item.totalChars = prose.length;
        item.textTruncated = start + slice.length < prose.length;
      }
    }

    bytes += JSON.stringify(item).length;
    if (bytes > MAX_TOOL_RESULT_BYTES && items.length) {
      truncated = true;
      break;
    }
    items.push(item);
  }

  return {
    items,
    missing,
    truncated,
    ...(truncated
      ? { guidance: 'The result hit its size limit. Ask for fewer refs, or use maxChars to page through long notes.' }
      : {}),
  };
}
