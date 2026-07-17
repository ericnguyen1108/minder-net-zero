/**
 * Client transport for the pilot API (POST /api/pilot).
 *
 * Every migrated client-storage function calls `pilot(action, payload)` instead
 * of IndexedDB. This unwraps the { ok, data } / { error: { code } } envelope and
 * maps the two meaningful HTTP statuses to typed errors so callers can react:
 *   - 401 -> PilotAuthError  (the session lapsed; the UI should re-gate)
 *   - 409 -> PilotConflictError (revision_conflict / already_revealed / stale_lease)
 * Everything else is a PilotError carrying the server error code.
 */

export class PilotError extends Error {
  code: string;
  constructor(message: string, code = "action_failed") {
    super(message);
    this.name = "PilotError";
    this.code = code;
  }
}

export class PilotAuthError extends PilotError {
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message, "authentication_required");
    this.name = "PilotAuthError";
  }
}

export class PilotConflictError extends PilotError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = "PilotConflictError";
  }
}

type Envelope<T> = { ok?: boolean; data?: T; error?: { code?: string; message?: string } };

export async function pilot<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/pilot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload }),
      cache: "no-store",
    });
  } catch {
    throw new PilotError("Could not reach the server. Check your connection and try again.", "network_error");
  }

  let body: Envelope<T>;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new PilotError("The server returned an unreadable response.", "bad_response");
  }

  if (response.ok && body.ok) return body.data as T;

  const code = body.error?.code ?? "action_failed";
  const message = body.error?.message ?? code;
  if (response.status === 401) throw new PilotAuthError(message);
  if (response.status === 409) throw new PilotConflictError(message, code);
  throw new PilotError(message, code);
}
