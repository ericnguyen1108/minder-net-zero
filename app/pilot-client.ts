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

// Vercel rejects function request bodies above 4.5 MB before this app can return
// JSON. Leave headroom for platform framing and count UTF-8 bytes, not JS code
// units, so the browser can give the organiser a useful error first.
export const MAX_PILOT_REQUEST_BYTES = 4_000_000;

export function pilotRequestByteLength(
  action: string,
  payload: Record<string, unknown> = {},
): number {
  return new TextEncoder().encode(JSON.stringify({ action, payload })).byteLength;
}

const REQUEST_TOO_LARGE_MESSAGE =
  "This import is too large to send safely. Select fewer answer columns or shorten long answers, then try again.";

function unreadableResponseError(status: number): PilotError {
  if (status === 413) {
    return new PilotError(REQUEST_TOO_LARGE_MESSAGE, "request_too_large");
  }
  if (status >= 500) {
    return new PilotError(
      "The server is temporarily unavailable. Keep this tab open and try again.",
      "server_unavailable",
    );
  }
  return new PilotError("The server returned an unreadable response.", "bad_response");
}

export async function pilot<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  let requestBody: string;
  try {
    requestBody = JSON.stringify({ action, payload });
  } catch {
    throw new PilotError("This request could not be prepared safely.", "invalid_request");
  }
  if (new TextEncoder().encode(requestBody).byteLength > MAX_PILOT_REQUEST_BYTES) {
    throw new PilotError(REQUEST_TOO_LARGE_MESSAGE, "request_too_large");
  }

  let response: Response;
  try {
    response = await fetch("/api/pilot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      cache: "no-store",
    });
  } catch {
    throw new PilotError("Could not reach the server. Check your connection and try again.", "network_error");
  }

  let body: Envelope<T>;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw unreadableResponseError(response.status);
  }

  if (response.ok && body.ok) return body.data as T;

  const code = body.error?.code ?? "action_failed";
  const message = body.error?.message ?? code;
  if (response.status === 401) throw new PilotAuthError(message);
  if (response.status === 409) throw new PilotConflictError(message, code);
  throw new PilotError(message, code);
}
