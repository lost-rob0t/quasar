export type IntegrationStatus = "disabled" | "connecting" | "active" | "degraded" | "error";

export interface IntegrationCapability {
  id: string;
  label: string;
  optional: true;
}

export interface IntegrationState {
  capability: IntegrationCapability;
  status: IntegrationStatus;
  message?: string;
}
