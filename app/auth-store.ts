/**
 * Persistent organiser password storage.
 *
 * The initial password still comes from ORGANISER_ACCESS_CODE. Once the
 * organiser changes it, a salted PBKDF2 verifier is stored in an Upstash Redis
 * database and becomes the only accepted password. Plaintext passwords are
 * never stored or logged.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const PASSWORD_RECORD_KEY = "minder-net-zero:auth:organiser:v1";
const PASSWORD_RECORD_SCHEMA = 1;
const PBKDF2_ITERATIONS = 310_000;
const PASSWORD_STORE_TIMEOUT_MS = 5_000;

export type PasswordRecord = {
  schemaVersion: 1;
  salt: string;
  verifier: string;
  iterations: number;
  credentialVersion: string;
  updatedAt: string;
};

type StoreConfig = {
  url: string;
  token: string;
};

function storeConfig(): StoreConfig | null {
  if (typeof process === "undefined") return null;
  const url = (
    process.env.MINDER_AUTH_KV_REST_API_URL ??
    process.env.AUTH_KV_REST_API_URL ??
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.KV_REST_API_URL ??
    ""
  ).trim();
  const token = (
    process.env.MINDER_AUTH_KV_REST_API_TOKEN ??
    process.env.AUTH_KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN ??
    ""
  ).trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export function passwordStoreIsConfigured(): boolean {
  return storeConfig() !== null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveVerifier(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  // Copy into a concrete ArrayBuffer. TypeScript 5.9 distinguishes it from a
  // SharedArrayBuffer-backed view, while WebCrypto requires BufferSource.
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations },
    keyMaterial,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let difference = 0;
  for (let index = 0; index < bytesA.length; index += 1) difference |= bytesA[index] ^ bytesB[index];
  return difference === 0;
}

function isPasswordRecord(value: unknown): value is PasswordRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === PASSWORD_RECORD_SCHEMA &&
    typeof record.salt === "string" &&
    typeof record.verifier === "string" &&
    Number.isInteger(record.iterations) &&
    Number(record.iterations) >= 100_000 &&
    typeof record.credentialVersion === "string" &&
    record.credentialVersion.length >= 16 &&
    typeof record.updatedAt === "string"
  );
}

async function redisCommand(command: readonly string[]): Promise<unknown> {
  const config = storeConfig();
  if (!config) throw new Error("password_store_not_configured");
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(PASSWORD_STORE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`password_store_unavailable:${response.status}`);
  const payload = (await response.json()) as { result?: unknown; error?: unknown };
  if (payload.error) throw new Error("password_store_unavailable");
  return payload.result;
}

export async function loadPasswordRecord(): Promise<PasswordRecord | null> {
  if (!passwordStoreIsConfigured()) return null;
  const result = await redisCommand(["GET", PASSWORD_RECORD_KEY]);
  if (result === null || result === undefined) return null;
  if (typeof result !== "string") throw new Error("password_store_invalid_record");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error("password_store_invalid_record");
  }
  if (!isPasswordRecord(parsed)) throw new Error("password_store_invalid_record");
  return parsed;
}

export async function verifyStoredPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const verifier = await deriveVerifier(password, base64UrlDecode(record.salt), record.iterations);
  return constantTimeEqual(verifier, record.verifier);
}

export async function savePassword(password: string, now: Date = new Date()): Promise<PasswordRecord> {
  if (!passwordStoreIsConfigured()) throw new Error("password_store_not_configured");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("password_length_invalid");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const record: PasswordRecord = {
    schemaVersion: PASSWORD_RECORD_SCHEMA,
    salt: base64UrlEncode(salt),
    verifier: await deriveVerifier(password, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
    credentialVersion: crypto.randomUUID(),
    updatedAt: now.toISOString(),
  };
  await redisCommand(["SET", PASSWORD_RECORD_KEY, JSON.stringify(record)]);
  return record;
}
