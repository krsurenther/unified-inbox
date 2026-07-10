const BACKOFF_MS = [5_000, 30_000, 120_000];

/**
 * Reconnect delay for the Nth consecutive attempt (1-based): 5s, 30s, 2m, then
 * undefined = stop auto-retrying (a manual Connect or the liveness probe takes over).
 */
export function nextReconnectDelay(attempt: number): number | undefined {
  return BACKOFF_MS[attempt - 1];
}
