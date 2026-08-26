export interface ProviderVerificationEvidence {
  readonly model: string;
  readonly test: "native-tool-call-and-result";
  readonly verifiedAt: string;
}

export const EXCLUDED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "google-vertex",
]);

export const PROVIDER_VERIFICATIONS: Readonly<
  Record<string, ProviderVerificationEvidence>
> = {};

export const VERIFIED_PROVIDER_IDS: ReadonlySet<string> = new Set(
  Object.keys(PROVIDER_VERIFICATIONS),
);
