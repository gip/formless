/**
 * Epic / SMART-on-FHIR client, ported verbatim from yesyouhealth's `lib/epic.ts`.
 *
 * It is browser code and always was: PKCE with `code_challenge_method=S256`, a
 * public client with no secret, and the token exchange running in the page. What
 * changes here is only *which* page runs it. In yesyouhealth this executed in the
 * app the user was looking at; in Formless Labs it runs on the host, because the guest
 * lives at an ephemeral WebContainer origin that Epic can never have registered
 * as a redirect_uri — and because the guest is rewritable by an agent, which is
 * not somewhere an access token should ever be.
 */

export type JsonObject = Record<string, unknown>;

export class FhirError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface SmartConfiguration extends JsonObject {
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface TokenResponse extends JsonObject {
  access_token: string;
  patient?: string;
}

export interface ExportResult {
  data: Record<string, unknown>;
  errors: Record<string, string>;
  priorAuthorizations: JsonObject[];
}

export interface BinaryAttachment {
  key: string;
  binaryId: string;
  contentType: string;
  blob: Blob;
  sourceDocumentReference?: string;
  title?: string;
}

export interface ImportProgress {
  completedSearches: number;
  totalSearches: number;
  resourceCount: number;
  attachmentCount: number;
  attachmentBytes: number;
}

export interface PatientExportInput {
  fhirBase: string;
  patientId: string;
  accessToken: string;
  collectData?: boolean;
  includeAttachments?: boolean;
  includePriorAuthorizations?: boolean;
  onResources?: (group: string, resources: JsonObject[]) => Promise<void> | void;
  onAttachment?: (attachment: BinaryAttachment) => Promise<void> | void;
  onProgress?: (progress: ImportProgress) => void;
}

interface ResourceRequest {
  label: string;
  type: string;
  query?: Record<string, string>;
  variant?: string;
}

const RESOURCE_REQUESTS: ResourceRequest[] = [
  { label: "AllergyIntolerance", type: "AllergyIntolerance" },
  {
    label: "Appointment",
    type: "Appointment",
    query: { "service-category": "appointment" },
    variant: "appointments",
  },
  {
    label: "Appointment",
    type: "Appointment",
    query: { "service-category": "surgery" },
    variant: "scheduled surgeries",
  },
  {
    label: "CarePlan",
    type: "CarePlan",
    query: { category: "38717003" },
  },
  { label: "CareTeam", type: "CareTeam" },
  { label: "Condition", type: "Condition" },
  { label: "Coverage", type: "Coverage" },
  { label: "DeviceUseStatement", type: "DeviceUseStatement" },
  { label: "DiagnosticReport", type: "DiagnosticReport" },
  { label: "DocumentReference", type: "DocumentReference" },
  { label: "Encounter", type: "Encounter" },
  { label: "FamilyMemberHistory", type: "FamilyMemberHistory" },
  { label: "Goal", type: "Goal" },
  { label: "Immunization", type: "Immunization" },
  { label: "MedicationDispense", type: "MedicationDispense" },
  { label: "MedicationRequest", type: "MedicationRequest" },
  {
    label: "Observation",
    type: "Observation",
    query: { category: "laboratory" },
    variant: "laboratory",
  },
  {
    label: "Observation",
    type: "Observation",
    query: { category: "vital-signs" },
    variant: "vital signs",
  },
  {
    label: "Observation",
    type: "Observation",
    query: { category: "social-history" },
    variant: "social history",
  },
  { label: "Procedure", type: "Procedure" },
  { label: "QuestionnaireResponse", type: "QuestionnaireResponse" },
  { label: "ServiceRequest", type: "ServiceRequest" },
  {
    label: "PriorAuthorization",
    type: "ExplanationOfBenefit",
    query: { use: "preauthorization" },
  },
];

const MAX_PAGES_PER_RESOURCE = 500;
const MAX_RESOURCES_PER_TYPE = 50_000;
const MAX_ATTACHMENTS = 500;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/rtf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "text/html",
  "text/plain",
  "text/rtf",
]);

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(asObject).filter((item): item is JsonObject => Boolean(item))
    : [];
}

function operationOutcomeDetail(value: JsonObject): string {
  const oauthDetail = asString(value.error_description) ?? asString(value.error);
  if (oauthDetail) return oauthDetail;
  const issue = objects(value.issue)[0];
  const details = asObject(issue?.details);
  return asString(issue?.diagnostics) ?? asString(details?.text) ?? "Request failed";
}

async function parseResponse(response: Response): Promise<JsonObject> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FhirError(`Server returned HTTP ${response.status} with a non-JSON response.`, response.status);
  }
  const object = asObject(value);
  if (!object) throw new FhirError("Server returned an unexpected JSON response.", response.status);
  if (!response.ok) {
    throw new FhirError(`${operationOutcomeDetail(object)} (HTTP ${response.status})`, response.status);
  }
  return object;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new FhirError(
      `Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseResponse(response);
}

export function normalizeFhirBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new FhirError("FHIR endpoints must use HTTPS.");
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function smartConfigurationUrl(fhirBase: string): string {
  return new URL(".well-known/smart-configuration", normalizeFhirBase(fhirBase)).toString();
}

export async function discoverSmart(fhirBase: string): Promise<SmartConfiguration> {
  const value = await fetchJson(smartConfigurationUrl(fhirBase), {
    headers: { Accept: "application/json" },
  });
  const authorizationEndpoint = asString(value.authorization_endpoint);
  const tokenEndpoint = asString(value.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new FhirError("SMART configuration is missing its authorization or token endpoint.");
  }
  if (new URL(authorizationEndpoint).protocol !== "https:" || new URL(tokenEndpoint).protocol !== "https:") {
    throw new FhirError("SMART authorization endpoints must use HTTPS.");
  }
  return {
    ...value,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  return { verifier, challenge };
}

export function createOAuthState(): string {
  return randomBase64Url(32);
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  fhirBase: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    state: input.state,
    aud: normalizeFhirBase(input.fhirBase),
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeAuthorizationCode(input: {
  tokenEndpoint: string;
  code: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  if (input.clientSecret) form.set("client_secret", input.clientSecret);
  const value = await fetchJson(input.tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const accessToken = asString(value.access_token);
  if (!accessToken) throw new FhirError("The token response did not include an access token.");
  const patient = asString(value.patient);
  return {
    ...value,
    access_token: accessToken,
    ...(patient ? { patient } : {}),
  };
}

export function safeNextUrl(next: string, current: string, fhirBase: string): string {
  const candidate = new URL(next, current);
  const base = new URL(normalizeFhirBase(fhirBase));
  if (
    candidate.protocol !== base.protocol ||
    candidate.host !== base.host ||
    !candidate.pathname.startsWith(base.pathname)
  ) {
    throw new FhirError("FHIR server returned an unsafe pagination URL.");
  }
  return candidate.toString();
}

export function safeBinaryUrl(reference: string, fhirBase: string): string {
  const candidate = new URL(reference, normalizeFhirBase(fhirBase));
  const base = new URL(normalizeFhirBase(fhirBase));
  const relativePath = candidate.pathname.slice(base.pathname.length);
  if (
    candidate.protocol !== base.protocol ||
    candidate.host !== base.host ||
    !candidate.pathname.startsWith(base.pathname) ||
    !/^Binary\/[^/]+$/.test(relativePath) ||
    candidate.search ||
    candidate.hash
  ) {
    throw new FhirError("FHIR document contained an unsafe Binary attachment URL.");
  }
  return candidate.toString();
}

async function authorizedFhirGet(url: string, accessToken: string): Promise<JsonObject> {
  return fetchJson(url, {
    headers: {
      Accept: "application/fhir+json, application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

interface BinaryReference {
  url: string;
  binaryId: string;
  declaredContentType?: string;
  sourceDocumentReference?: string;
  title?: string;
}

function binaryReferences(
  documentReferences: JsonObject[],
  fhirBase: string,
): { references: BinaryReference[]; errors: string[] } {
  const references = new Map<string, BinaryReference>();
  const errors: string[] = [];
  for (const document of documentReferences) {
    for (const content of objects(document.content)) {
      const attachment = asObject(content.attachment);
      const reference = asString(attachment?.url);
      if (!reference) continue;
      try {
        const url = safeBinaryUrl(reference, fhirBase);
        const binaryId = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
        if (!binaryId || references.has(url)) continue;
        const documentId = asString(document.id);
        const sourceDocumentReference = documentId
          ? `DocumentReference/${documentId}`
          : undefined;
        const title =
          asString(attachment?.title) ??
          asString(document.description) ??
          asString(document.id);
        const declaredContentType = asString(attachment?.contentType);
        references.set(url, {
          url,
          binaryId,
          ...(declaredContentType ? { declaredContentType } : {}),
          ...(sourceDocumentReference ? { sourceDocumentReference } : {}),
          ...(title ? { title } : {}),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { references: [...references.values()], errors };
}

function normalizedContentType(value: string | null | undefined): string | undefined {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType || undefined;
}

function blobFromBase64(data: string, contentType: string): Blob {
  let decoded: string;
  try {
    decoded = atob(data);
  } catch {
    throw new FhirError("FHIR Binary data was not valid base64.");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}

async function fetchBinaryAttachment(
  reference: BinaryReference,
  accessToken: string,
): Promise<BinaryAttachment> {
  let response: Response;
  try {
    response = await fetch(reference.url, {
      cache: "no-store",
      credentials: "omit",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new FhirError(
      `Could not retrieve Binary/${reference.binaryId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    await parseResponse(response);
    throw new FhirError(`Could not retrieve Binary/${reference.binaryId}.`);
  }

  const responseContentType = normalizedContentType(response.headers.get("Content-Type"));
  let contentType = normalizedContentType(reference.declaredContentType) ?? responseContentType;
  let blob: Blob;
  if (
    responseContentType === "application/fhir+json" ||
    responseContentType === "application/json"
  ) {
    const binary = await parseResponse(response);
    if (binary.resourceType !== "Binary" || !asString(binary.data)) {
      throw new FhirError(`Binary/${reference.binaryId} returned an unexpected response.`);
    }
    contentType = normalizedContentType(asString(binary.contentType)) ?? contentType;
    blob = blobFromBase64(asString(binary.data)!, contentType ?? "application/octet-stream");
  } else {
    blob = await response.blob();
    contentType = contentType ?? normalizedContentType(blob.type);
  }

  if (!contentType || !ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
    throw new FhirError(
      `Binary/${reference.binaryId} used unsupported content type ${contentType ?? "unknown"}.`,
    );
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    throw new FhirError(
      `Binary/${reference.binaryId} exceeded the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per-file limit.`,
    );
  }

  return {
    key: reference.binaryId,
    binaryId: reference.binaryId,
    contentType,
    blob: blob.type === contentType ? blob : blob.slice(0, blob.size, contentType),
    ...(reference.sourceDocumentReference
      ? { sourceDocumentReference: reference.sourceDocumentReference }
      : {}),
    ...(reference.title ? { title: reference.title } : {}),
  };
}

async function fetchBundle(
  url: string,
  fhirBase: string,
  accessToken: string,
  options: {
    collect: boolean;
    onPage?: (resources: JsonObject[]) => Promise<void> | void;
  },
): Promise<JsonObject[]> {
  const resources: JsonObject[] = [];
  const visited = new Set<string>();
  let next: string | undefined = url;
  let pageCount = 0;
  let resourceCount = 0;

  while (next) {
    if (pageCount >= MAX_PAGES_PER_RESOURCE) {
      throw new FhirError(`FHIR search exceeded ${MAX_PAGES_PER_RESOURCE} pages.`);
    }
    if (visited.has(next)) throw new FhirError("FHIR server returned a pagination loop.");
    visited.add(next);
    pageCount += 1;
    const current = next;
    const bundle = await authorizedFhirGet(current, accessToken);
    if (bundle.resourceType !== "Bundle") throw new FhirError("FHIR search did not return a Bundle.");
    const pageResources: JsonObject[] = [];
    for (const entry of objects(bundle.entry)) {
      const resource = asObject(entry.resource);
      if (resource) pageResources.push(resource);
      resourceCount += resource ? 1 : 0;
      if (resourceCount > MAX_RESOURCES_PER_TYPE) {
        throw new FhirError(`FHIR search exceeded ${MAX_RESOURCES_PER_TYPE} resources.`);
      }
    }
    if (options.collect) resources.push(...pageResources);
    if (pageResources.length) await options.onPage?.(pageResources);
    next = undefined;
    for (const link of objects(bundle.link)) {
      const linkUrl = asString(link.url);
      if (link.relation === "next" && linkUrl) {
        next = safeNextUrl(linkUrl, current, fhirBase);
        break;
      }
    }
  }
  return resources;
}

async function fetchPatient(fhirBase: string, patientId: string, accessToken: string): Promise<JsonObject> {
  const url = new URL(`Patient/${encodeURIComponent(patientId)}`, fhirBase);
  return authorizedFhirGet(url.toString(), accessToken);
}

async function fetchPatientSearch(
  request: ResourceRequest,
  fhirBase: string,
  patientId: string,
  accessToken: string,
  options: {
    collect: boolean;
    onPage?: (resources: JsonObject[]) => Promise<void> | void;
  },
): Promise<JsonObject[]> {
  const url = new URL(request.type, fhirBase);
  url.search = new URLSearchParams({
    patient: patientId,
    _count: "100",
    ...request.query,
  }).toString();
  return fetchBundle(url.toString(), fhirBase, accessToken, options);
}

async function parallelMap<T, U>(items: T[], concurrency: number, worker: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  let failure: unknown;
  async function consume(): Promise<void> {
    while (cursor < items.length && failure === undefined) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index]!);
      } catch (error) {
        failure = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  if (failure !== undefined) throw failure;
  return results;
}

function resourceIdentity(resource: JsonObject): string | undefined {
  const resourceType = asString(resource.resourceType);
  const id = asString(resource.id);
  return resourceType && id ? `${resourceType}/${id}` : undefined;
}

function appendUniqueResources(target: JsonObject[], incoming: JsonObject[]): void {
  const identities = new Set(
    target.map(resourceIdentity).filter((value): value is string => Boolean(value)),
  );
  for (const resource of incoming) {
    const identity = resourceIdentity(resource);
    if (identity && identities.has(identity)) continue;
    target.push(resource);
    if (identity) identities.add(identity);
  }
}

function resourceRequestError(request: ResourceRequest, error: unknown): string {
  if (
    request.label === "PriorAuthorization" &&
    error instanceof FhirError &&
    (error.status === 400 || error.status === 403) &&
    /not authorized/i.test(error.message)
  ) {
    return "Prior authorization data is unavailable because this Epic client is not enabled for ExplanationOfBenefit.Search (Prior Auth). Enable that API in the Epic app registration and re-import. Search results were not included.";
  }
  return error instanceof Error ? error.message : String(error);
}

class ImportSinkError extends Error {
  constructor(readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
  }
}

export async function exportPatientRecord(input: PatientExportInput): Promise<ExportResult> {
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const collectData = input.collectData !== false;
  const documentReferences: JsonObject[] = [];
  let completedSearches = 0;
  let resourceCount = 0;
  let attachmentCount = 0;
  let attachmentBytes = 0;
  const resourceRequests = input.includePriorAuthorizations === false
    ? RESOURCE_REQUESTS.filter((request) => request.label !== "PriorAuthorization")
    : RESOURCE_REQUESTS;

  function reportProgress(): void {
    input.onProgress?.({
      completedSearches,
      totalSearches: resourceRequests.length,
      resourceCount,
      attachmentCount,
      attachmentBytes,
    });
  }

  async function emitResources(group: string, resources: JsonObject[]): Promise<void> {
    if (!resources.length) return;
    try {
      await input.onResources?.(group, resources);
    } catch (error) {
      throw new ImportSinkError(error);
    }
    resourceCount += resources.length;
    reportProgress();
  }

  try {
    const patient = await fetchPatient(input.fhirBase, input.patientId, input.accessToken);
    if (collectData) data.Patient = patient;
    await emitResources("Patient", [patient]);
  } catch (error) {
    if (error instanceof ImportSinkError) throw error.originalError;
    errors.Patient = error instanceof Error ? error.message : String(error);
  }

  const outcomes = await parallelMap(resourceRequests, 4, async (request) => {
    try {
      const resources = await fetchPatientSearch(
        request,
        input.fhirBase,
        input.patientId,
        input.accessToken,
        {
          collect: collectData,
          onPage: async (pageResources) => {
            if (request.label === "DocumentReference") {
              appendUniqueResources(documentReferences, pageResources);
            }
            await emitResources(request.label, pageResources);
          },
        },
      );
      return { request, resources } as const;
    } catch (error) {
      if (error instanceof ImportSinkError) throw error;
      return {
        request,
        error: resourceRequestError(request, error),
      } as const;
    } finally {
      completedSearches += 1;
      reportProgress();
    }
  });

  const priorAuthorizations: JsonObject[] = [];
  const resourceGroups = new Map<string, JsonObject[]>();
  const resourceErrors = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if ("error" in outcome) {
      const messages = resourceErrors.get(outcome.request.label) ?? [];
      // Read once, defensively. yesyouhealth compiles with
      // `exactOptionalPropertyTypes`, under which `in` narrowing gives this a
      // plain `string`; this repo does not set that flag, so it stays
      // `string | undefined` here. Behaviour is identical either way.
      const detail = outcome.error ?? "The request failed.";
      messages.push(
        outcome.request.variant ? `${outcome.request.variant}: ${detail}` : detail,
      );
      resourceErrors.set(outcome.request.label, messages);
    } else if (outcome.request.label === "PriorAuthorization") {
      if (collectData) appendUniqueResources(priorAuthorizations, outcome.resources);
    } else {
      if (collectData) {
        const resources = resourceGroups.get(outcome.request.label) ?? [];
        appendUniqueResources(resources, outcome.resources);
        resourceGroups.set(outcome.request.label, resources);
      }
    }
  }

  if (input.includeAttachments) {
    const attachmentErrors: string[] = [];
    const extracted = binaryReferences(documentReferences, input.fhirBase);
    attachmentErrors.push(...extracted.errors);
    if (extracted.references.length > MAX_ATTACHMENTS) {
      attachmentErrors.push(
        `Only the first ${MAX_ATTACHMENTS} clinical-note attachments were considered.`,
      );
    }

    for (const reference of extracted.references.slice(0, MAX_ATTACHMENTS)) {
      try {
        const attachment = await fetchBinaryAttachment(reference, input.accessToken);
        if (attachmentBytes + attachment.blob.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          attachmentErrors.push(
            `Clinical-note attachments reached the ${
              MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024
            } MB total import limit. Remaining files were not imported.`,
          );
          break;
        }
        try {
          await input.onAttachment?.(attachment);
        } catch (error) {
          throw new ImportSinkError(error);
        }
        attachmentCount += 1;
        attachmentBytes += attachment.blob.size;
        reportProgress();
      } catch (error) {
        if (error instanceof ImportSinkError) throw error.originalError;
        attachmentErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (attachmentErrors.length) {
      const uniqueErrors = [...new Set(attachmentErrors)];
      errors.Binary = uniqueErrors.length > 10
        ? `${uniqueErrors.slice(0, 10).join(" ")} ${uniqueErrors.length - 10} additional attachment errors were omitted.`
        : uniqueErrors.join(" ");
    }
  }

  for (const [label, resources] of resourceGroups) data[label] = resources;
  for (const [label, messages] of resourceErrors) errors[label] = messages.join(" ");

  return { data, errors, priorAuthorizations };
}
