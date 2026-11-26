const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export function retryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? 30_000;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
