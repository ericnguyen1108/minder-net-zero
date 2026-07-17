import { isLocalHostHeader } from "../app/auth.ts";

export const MAX_PLATFORM_BODY_BYTES = 32_768;
export const MAX_LARGE_PLATFORM_BODY_BYTES = 1_048_576;

export function platformJson(value: unknown, status = 200, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Vary", "Cookie");
  return Response.json(value, { status, headers });
}

export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === "same-origin" ||
    (process.env.NODE_ENV !== "production" && isLocalHostHeader(request.headers.get("host")));
}

function declaredBodyLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new Error("invalid_content_length");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("invalid_content_length");
  return value;
}

async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = declaredBodyLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new Error("body_too_large");
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new Error("unsupported_content_encoding");
  }
  if (!request.body) {
    if (declared !== null && declared !== 0) throw new Error("invalid_content_length");
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body_too_large").catch(() => undefined);
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== total) throw new Error("invalid_content_length");

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readPlatformJson(
  request: Request,
  options: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const requestedMax = options.maxBytes ?? MAX_PLATFORM_BODY_BYTES;
  if (!Number.isSafeInteger(requestedMax) || requestedMax <= 0 || requestedMax > MAX_LARGE_PLATFORM_BODY_BYTES) {
    throw new TypeError("invalid_body_limit");
  }
  const bytes = await readBodyBytes(request, requestedMax);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_json");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value as Record<string, unknown>;
}

export function requestId(request: Request): string {
  const supplied = request.headers.get("x-vercel-id") ?? request.headers.get("x-request-id") ?? "";
  return /^[A-Za-z0-9_.:/-]{1,159}$/.test(supplied) ? supplied : crypto.randomUUID();
}
