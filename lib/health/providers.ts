export interface ProviderCapabilities {
  attachments: boolean;
  priorAuthorizations: boolean;
}

export interface ProviderProfile {
  id: string;
  name: string;
  myChartName: string;
  vendor: "epic";
  adapter: "epic-r4";
  environment: "production" | "sandbox";
  fhirBase: string;
  clientId?: string;
  scope?: string;
  capabilities: ProviderCapabilities;
  enabled: boolean;
}

export const PROVIDERS = {
  ucsf: {
    id: "ucsf",
    name: "UCSF Health",
    myChartName: "UCSF MyChart",
    vendor: "epic",
    adapter: "epic-r4",
    environment: "production",
    fhirBase: "https://unified-api.ucsf.edu/clinical/apex/api/FHIR/R4/",
    capabilities: {
      attachments: true,
      priorAuthorizations: true,
    },
    enabled: true,
  },
  sutter: {
    id: "sutter",
    name: "Sutter Health",
    myChartName: "Sutter My Health Online",
    vendor: "epic",
    adapter: "epic-r4",
    environment: "production",
    fhirBase: "https://apiservices.sutterhealth.org/ifs/api/FHIR/R4/",
    capabilities: {
      attachments: true,
      priorAuthorizations: true,
    },
    enabled: true,
  },
  "epic-sandbox": {
    id: "epic-sandbox",
    name: "Epic Sandbox",
    myChartName: "Epic test MyChart",
    vendor: "epic",
    adapter: "epic-r4",
    environment: "sandbox",
    fhirBase: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/",
    capabilities: {
      attachments: true,
      priorAuthorizations: true,
    },
    enabled: true,
  },
} as const satisfies Record<string, ProviderProfile>;

export type ProviderId = keyof typeof PROVIDERS;

export const PROVIDER_REGISTRY_VERSION = 1;
export const DEFAULT_PROVIDER_ID: ProviderId = "ucsf";

export function getProvider(value: string | null | undefined): ProviderProfile | undefined {
  if (!value || !(value in PROVIDERS)) return undefined;
  return PROVIDERS[value as ProviderId];
}

export function selectableProviders(includeSandbox = false): ProviderProfile[] {
  return Object.values(PROVIDERS).filter(
    (provider) =>
      provider.enabled && (includeSandbox || provider.environment === "production"),
  );
}

export function providerClientId(
  provider: ProviderProfile,
  defaultClientId: string,
): string {
  return provider.clientId ?? defaultClientId;
}

export function providerScope(
  provider: ProviderProfile,
  defaultScope: string,
): string {
  return provider.scope ?? defaultScope;
}
