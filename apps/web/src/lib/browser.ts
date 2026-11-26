export interface BrowserProblem {
  readonly code?: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
}

export async function readProblem(response: Response): Promise<BrowserProblem> {
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value['code'] === 'string' ? { code: value['code'] } : {}),
      ...(typeof value['message'] === 'string' && value['message'].length <= 300
        ? { message: value['message'] }
        : {}),
      ...(typeof value['retryAfterMs'] === 'number' &&
      Number.isFinite(value['retryAfterMs']) &&
      value['retryAfterMs'] >= 0
        ? { retryAfterMs: value['retryAfterMs'] }
        : {}),
    };
  } catch {
    return {};
  }
}

export function fallbackMessage(status: number): string {
  if (status === 401) {
    return 'Invalid username or password.';
  }
  if (status === 403) {
    return 'The security check failed. Reload the page and try again.';
  }
  if (status === 429) {
    return 'Too many attempts. Wait briefly before trying again.';
  }
  if (status === 503) {
    return 'A required service is unavailable. Try again shortly.';
  }
  return `The request failed with status ${status}.`;
}
