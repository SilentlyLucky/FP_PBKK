export const PROVIDER_STATUS_REFRESH_EVENT = "promptlab:provider-status-refresh";

export function notifyProviderStatusRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROVIDER_STATUS_REFRESH_EVENT));
}
