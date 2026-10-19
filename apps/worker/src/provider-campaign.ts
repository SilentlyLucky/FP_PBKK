import {
  isProviderVerificationCampaignConfigured,
  reserveInferenceCall,
  type SmokeProvider,
} from "@promptlab/providers/provider-smoke-ledger";

/** Reserve a campaign call before starting provider work when a campaign is active. */
export async function withProviderInferenceReservation<T>(
  provider: SmokeProvider,
  invoke: () => Promise<T>,
): Promise<T> {
  if (isProviderVerificationCampaignConfigured()) {
    await reserveInferenceCall(provider);
  }
  return invoke();
}
