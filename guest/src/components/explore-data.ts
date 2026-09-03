import type { HealthExportDocument, JsonObject } from './health-types';

export interface ResourceGroup {
  key: string;
  label: string;
  resources: JsonObject[];
}

export interface RenderedField {
  label: string;
  value: string;
}

const GROUP_LABELS: Record<string, string> = {
  Patient: "Patient",
  AllergyIntolerance: "Allergies",
  Appointment: "Appointments",
  CarePlan: "Care plans",
  CareTeam: "Care team",
  Condition: "Conditions",
  Coverage: "Coverage",
  DeviceUseStatement: "Devices",
  DiagnosticReport: "Diagnostic reports",
  DocumentReference: "Documents",
  Encounter: "Encounters",
  FamilyMemberHistory: "Family history",
  Goal: "Goals",
  Immunization: "Immunizations",
  MedicationDispense: "Medication fills",
  MedicationRequest: "Medications",
  Observation: "Observations",
  Procedure: "Procedures",
  QuestionnaireResponse: "Questionnaires",
  ServiceRequest: "Orders",
  PriorAuthorization: "Prior authorizations",
  Binary: "Clinical-note files",
};

const GROUP_ORDER = Object.keys(GROUP_LABELS);

/** The patient-facing name for a FHIR resource type. */
export function groupLabel(key: string): string {
  return GROUP_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
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
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
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
  return amount ? `${amount}${unit ? ` ${unit}` : ""}` : undefined;
}

function humanName(value: unknown): string | undefined {
  const object = Array.isArray(value) ? asObject(value[0]) : asObject(value);
  if (!object) return undefined;
  const direct = text(object.text);
  if (direct) return direct;
  const given = Array.isArray(object.given) ? object.given.map(text).filter(Boolean).join(" ") : "";
  const family = text(object.family) ?? "";
  return [given, family].filter(Boolean).join(" ") || undefined;
}

function joinValues(value: unknown, formatter: (item: unknown) => string | undefined = codeable): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  const formatted = values.map(formatter).filter((item): item is string => Boolean(item));
  return formatted.length ? formatted.join(", ") : undefined;
}

function add(fields: RenderedField[], label: string, value: string | undefined): void {
  if (value) fields.push({ label, value });
}

function fileSize(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function compactIdentifier(value: unknown): string | undefined {
  const identifier = text(value);
  if (!identifier || identifier.length <= 12) return identifier;
  return `${identifier.slice(0, 4)}...${identifier.slice(-4)}`;
}

function commonFields(resource: JsonObject): RenderedField[] {
  const fields: RenderedField[] = [];
  add(fields, "Status", text(resource.status));
  add(fields, "Identifier", text(resource.id));
  return fields;
}

export function getResourceGroups(healthExport: HealthExportDocument): ResourceGroup[] {
  const groups = new Map<string, JsonObject[]>();
  for (const [key, value] of Object.entries(healthExport.data)) {
    const resources = asObjects(value);
    if (resources.length) groups.set(key, resources);
  }
  if (healthExport.priorAuthorizations.length) {
    groups.set("PriorAuthorization", healthExport.priorAuthorizations);
  }
  if (healthExport.attachments?.length) {
    groups.set(
      "Binary",
      healthExport.attachments.map((attachment) => ({
        resourceType: "Binary",
        id: attachment.binaryId,
        key: attachment.key,
        contentType: attachment.contentType,
        size: attachment.size,
        ...(attachment.sourceDocumentReference
          ? { sourceDocumentReference: attachment.sourceDocumentReference }
          : {}),
        ...(attachment.title ? { title: attachment.title } : {}),
      })),
    );
  }

  return [...groups.entries()]
    .map(([key, resources]) => ({
      key,
      label: groupLabel(key),
      resources,
    }))
    .sort((left, right) => {
      const leftIndex = GROUP_ORDER.indexOf(left.key);
      const rightIndex = GROUP_ORDER.indexOf(right.key);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    });
}

export function patientDisplayName(healthExport: HealthExportDocument): string {
  const patient = asObject(healthExport.data.Patient);
  return humanName(patient?.name) ?? "Your health record";
}

export function resourceTitle(resource: JsonObject, fallbackLabel: string): string {
  switch (resource.resourceType) {
    case "Patient":
      return humanName(resource.name) ?? fallbackLabel;
    case "MedicationRequest":
      return codeable(resource.medicationCodeableConcept)
        ?? reference(resource.medicationReference)
        ?? fallbackLabel;
    case "Immunization":
      return codeable(resource.vaccineCode) ?? fallbackLabel;
    case "Goal":
      return codeable(resource.description) ?? fallbackLabel;
    case "CarePlan":
      return text(resource.title) ?? fallbackLabel;
    case "DocumentReference":
      return text(resource.description) ?? codeable(resource.type) ?? fallbackLabel;
    case "Appointment":
      return codeable(resource.appointmentType) ?? joinValues(resource.serviceType) ?? fallbackLabel;
    case "MedicationDispense":
      return codeable(resource.medicationCodeableConcept)
        ?? reference(resource.medicationReference)
        ?? fallbackLabel;
    case "ServiceRequest":
      return codeable(resource.code) ?? fallbackLabel;
    case "Binary":
      return compactIdentifier(resource.id) ?? fallbackLabel;
    default:
      return codeable(resource.code) ?? codeable(resource.type) ?? fallbackLabel;
  }
}

export function renderedFields(resource: JsonObject): RenderedField[] {
  const fields = commonFields(resource);
  switch (resource.resourceType) {
    case "Patient": {
      add(fields, "Name", humanName(resource.name));
      add(fields, "Date of birth", text(resource.birthDate));
      add(fields, "Gender", text(resource.gender));
      add(fields, "Contact", joinValues(resource.telecom, (item) => text(asObject(item)?.value)));
      add(fields, "Address", joinValues(resource.address, (item) => {
        const address = asObject(item);
        if (!address) return undefined;
        const lines = Array.isArray(address.line) ? address.line.map(text).filter(Boolean) : [];
        return [...lines, text(address.city), text(address.state), text(address.postalCode)]
          .filter(Boolean)
          .join(", ");
      }));
      break;
    }
    case "AllergyIntolerance": {
      add(fields, "Allergy or intolerance", codeable(resource.code));
      add(fields, "Clinical status", codeable(resource.clinicalStatus));
      add(fields, "Verification", codeable(resource.verificationStatus));
      add(fields, "Criticality", text(resource.criticality));
      add(fields, "Recorded", text(resource.recordedDate));
      const reactions = Array.isArray(resource.reaction)
        ? resource.reaction.flatMap((item) => {
          const reaction = asObject(item);
          return Array.isArray(reaction?.manifestation) ? reaction.manifestation : [];
        })
        : [];
      add(fields, "Reactions", joinValues(reactions));
      break;
    }
    case "Condition": {
      add(fields, "Condition", codeable(resource.code));
      add(fields, "Clinical status", codeable(resource.clinicalStatus));
      add(fields, "Verification", codeable(resource.verificationStatus));
      add(fields, "Onset", text(resource.onsetDateTime) ?? period(resource.onsetPeriod) ?? text(resource.onsetString));
      add(fields, "Recorded", text(resource.recordedDate));
      break;
    }
    case "Observation": {
      add(fields, "Observation", codeable(resource.code));
      add(fields, "Value", quantity(resource.valueQuantity)
        ?? codeable(resource.valueCodeableConcept)
        ?? text(resource.valueString)
        ?? text(resource.valueInteger)
        ?? text(resource.valueBoolean));
      add(fields, "Effective", text(resource.effectiveDateTime) ?? period(resource.effectivePeriod));
      add(fields, "Category", joinValues(resource.category));
      add(fields, "Interpretation", joinValues(resource.interpretation));
      add(fields, "Components", joinValues(resource.component, (item) => {
        const component = asObject(item);
        if (!component) return undefined;
        const name = codeable(component.code);
        const value = quantity(component.valueQuantity)
          ?? codeable(component.valueCodeableConcept)
          ?? text(component.valueString);
        return [name, value].filter(Boolean).join(": ") || undefined;
      }));
      add(fields, "Reference range", joinValues(resource.referenceRange, (item) => {
        const range = asObject(item);
        if (!range) return undefined;
        const low = quantity(range.low);
        const high = quantity(range.high);
        return text(range.text) ?? ([low, high].filter(Boolean).join(" – ") || undefined);
      }));
      add(fields, "Notes", joinValues(resource.note, (item) => text(asObject(item)?.text)));
      break;
    }
    case "MedicationRequest": {
      add(fields, "Medication", codeable(resource.medicationCodeableConcept) ?? reference(resource.medicationReference));
      add(fields, "Intent", text(resource.intent));
      add(fields, "Authored", text(resource.authoredOn));
      add(fields, "Dosage", joinValues(resource.dosageInstruction, (item) => text(asObject(item)?.text)));
      break;
    }
    case "Encounter": {
      add(fields, "Type", joinValues(resource.type));
      add(fields, "Class", codeable(resource.class));
      add(fields, "Period", period(resource.period));
      add(fields, "Reason", joinValues(resource.reasonCode));
      add(fields, "Location", joinValues(resource.location, (item) => reference(asObject(item)?.location)));
      break;
    }
    case "Procedure": {
      add(fields, "Procedure", codeable(resource.code));
      add(fields, "Performed", text(resource.performedDateTime) ?? period(resource.performedPeriod));
      add(fields, "Reason", joinValues(resource.reasonCode));
      add(fields, "Outcome", codeable(resource.outcome));
      break;
    }
    case "Immunization": {
      add(fields, "Vaccine", codeable(resource.vaccineCode));
      add(fields, "Date", text(resource.occurrenceDateTime) ?? text(resource.occurrenceString));
      add(fields, "Lot number", text(resource.lotNumber));
      add(fields, "Site", codeable(resource.site));
      break;
    }
    case "DiagnosticReport": {
      add(fields, "Report", codeable(resource.code));
      add(fields, "Effective", text(resource.effectiveDateTime) ?? period(resource.effectivePeriod));
      add(fields, "Issued", text(resource.issued));
      add(fields, "Conclusion", text(resource.conclusion));
      add(fields, "Results", joinValues(resource.result, reference));
      add(fields, "Presented files", joinValues(resource.presentedForm, (item) => {
        const attachment = asObject(item);
        return text(attachment?.title) ?? text(attachment?.contentType) ?? text(attachment?.url);
      }));
      break;
    }
    case "DocumentReference": {
      add(fields, "Document type", codeable(resource.type));
      add(fields, "Category", joinValues(resource.category));
      add(fields, "Date", text(resource.date));
      add(fields, "Description", text(resource.description));
      add(fields, "Author", joinValues(resource.author, reference));
      break;
    }
    case "Goal": {
      add(fields, "Goal", codeable(resource.description));
      add(fields, "Lifecycle status", text(resource.lifecycleStatus));
      add(fields, "Achievement", codeable(resource.achievementStatus));
      add(fields, "Start", text(resource.startDate) ?? codeable(resource.startCodeableConcept));
      break;
    }
    case "CarePlan": {
      add(fields, "Title", text(resource.title));
      add(fields, "Intent", text(resource.intent));
      add(fields, "Period", period(resource.period));
      add(fields, "Description", text(resource.description));
      add(fields, "Category", joinValues(resource.category));
      add(fields, "Addresses", joinValues(resource.addresses, reference));
      add(fields, "Goals", joinValues(resource.goal, reference));
      add(fields, "Activities", joinValues(resource.activity, (item) => {
        const detail = asObject(asObject(item)?.detail);
        return codeable(detail?.code) ?? text(detail?.description) ?? reference(asObject(item)?.reference);
      }));
      add(fields, "Notes", joinValues(resource.note, (item) => text(asObject(item)?.text)));
      break;
    }
    case "Coverage": {
      add(fields, "Coverage type", codeable(resource.type));
      add(fields, "Subscriber", reference(resource.subscriber));
      add(fields, "Beneficiary", reference(resource.beneficiary));
      add(fields, "Period", period(resource.period));
      add(fields, "Payor", joinValues(resource.payor, reference));
      break;
    }
    case "ExplanationOfBenefit": {
      add(fields, "Type", codeable(resource.type));
      add(fields, "Use", text(resource.use));
      add(fields, "Created", text(resource.created));
      add(fields, "Insurer", reference(resource.insurer));
      add(fields, "Outcome", text(resource.outcome));
      break;
    }
    case "Appointment": {
      add(fields, "Appointment type", codeable(resource.appointmentType));
      add(fields, "Service", joinValues(resource.serviceType));
      add(fields, "Start", text(resource.start));
      add(fields, "End", text(resource.end));
      add(fields, "Participants", joinValues(resource.participant, (item) =>
        reference(asObject(item)?.actor)));
      break;
    }
    case "CareTeam": {
      add(fields, "Category", joinValues(resource.category));
      add(fields, "Period", period(resource.period));
      add(fields, "Members", joinValues(resource.participant, (item) => {
        const participant = asObject(item);
        const role = joinValues(participant?.role);
        const member = reference(participant?.member);
        return [member, role].filter(Boolean).join(" — ") || undefined;
      }));
      break;
    }
    case "DeviceUseStatement": {
      add(fields, "Device", reference(resource.device));
      add(fields, "Timing", text(resource.timingDateTime) ?? period(resource.timingPeriod));
      add(fields, "Reason", joinValues(resource.reasonCode));
      break;
    }
    case "FamilyMemberHistory": {
      add(fields, "Relationship", codeable(resource.relationship));
      add(fields, "Name", text(resource.name));
      add(fields, "Sex", codeable(resource.sex));
      add(fields, "Conditions", joinValues(resource.condition, (item) =>
        codeable(asObject(item)?.code)));
      add(fields, "Notes", joinValues(resource.note, (item) => text(asObject(item)?.text)));
      break;
    }
    case "MedicationDispense": {
      add(fields, "Medication", codeable(resource.medicationCodeableConcept)
        ?? reference(resource.medicationReference));
      add(fields, "Handed over", text(resource.whenHandedOver));
      add(fields, "Prepared", text(resource.whenPrepared));
      add(fields, "Quantity", quantity(resource.quantity));
      add(fields, "Days supplied", quantity(resource.daysSupply));
      add(fields, "Dosage", joinValues(resource.dosageInstruction, (item) =>
        text(asObject(item)?.text)));
      break;
    }
    case "QuestionnaireResponse": {
      add(fields, "Questionnaire", reference(resource.questionnaire));
      add(fields, "Authored", text(resource.authored));
      add(fields, "Encounter", reference(resource.encounter));
      add(fields, "Answers", joinValues(resource.item, (item) => {
        const question = asObject(item);
        const answers = Array.isArray(question?.answer)
          ? question.answer.map((answer) => {
            const value = asObject(answer);
            return text(value?.valueString)
              ?? text(value?.valueBoolean)
              ?? text(value?.valueInteger)
              ?? codeable(value?.valueCoding)
              ?? quantity(value?.valueQuantity);
          }).filter(Boolean).join(", ")
          : undefined;
        return [text(question?.text), answers].filter(Boolean).join(": ") || undefined;
      }));
      break;
    }
    case "ServiceRequest": {
      add(fields, "Order", codeable(resource.code));
      add(fields, "Intent", text(resource.intent));
      add(fields, "Authored", text(resource.authoredOn));
      add(fields, "Occurrence", text(resource.occurrenceDateTime) ?? period(resource.occurrencePeriod));
      add(fields, "Requester", reference(resource.requester));
      add(fields, "Reason", joinValues(resource.reasonCode));
      break;
    }
    case "Binary": {
      add(fields, "File name", text(resource.title));
      add(fields, "Content type", text(resource.contentType));
      add(fields, "File size", fileSize(resource.size));
      add(fields, "Source document", text(resource.sourceDocumentReference));
      add(fields, "Storage", "Stored encrypted in this browser; included in decrypted downloads.");
      break;
    }
    default: {
      add(fields, "Code", codeable(resource.code));
      add(fields, "Category", joinValues(resource.category));
      add(fields, "Date", text(resource.date) ?? text(resource.authoredOn) ?? text(resource.created));
    }
  }
  return fields;
}
