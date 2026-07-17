/**
 * Access-code session auth for self-hosted deployments (e.g. Vercel).
 *
 * One shared organiser password exchanges for a signed, expiring session
 * cookie (HMAC-SHA256 with SESSION_SECRET). ORGANISER_ACCESS_CODE is the
 * bootstrap password. After the organiser changes it, the persistent password
 * record becomes authoritative and the bootstrap password stops working.
 *
 * Localhost requests bypass auth so local development and the test suite need
 * no configuration. Hosted platforms route requests by Host header, so a
 * spoofed `Host: localhost` never reaches a production deployment.
 */

import {
  loadPasswordRecord,
  passwordStoreIsConfigured,
  verifyStoredPassword,
} from "./auth-store.ts";

export const SESSION_COOKIE_NAME = "minder_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const BOOTSTRAP_TOKEN_VERSION = "v1";
const PERSISTENT_TOKEN_VERSION = "v2";
const SIGNING_CONTEXT = "minder-net-zero-session";

type AuthEnv = {
  ORGANISER_ACCESS_CODE?: string;
  SESSION_SECRET?: string;
};

function authEnv(): AuthEnv {
  if (typeof process === "undefined") return {};
  return {
    ORGANISER_ACCESS_CODE: process.env.ORGANISER_ACCESS_CODE,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };
}

export function authIsConfigured(): boolean {
  const env = authEnv();
  return (
    Boolean(env.SESSION_SECRET?.trim()) &&
    (Boolean(env.ORGANISER_ACCESS_CODE?.trim()) || passwordStoreIsConfigured())
  );
}

export function isLocalHostName(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

/** Host header values look like "example.com:3000" or "[::1]:3000". */
export function isLocalHostHeader(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const withoutPort = hostHeader.replace(/:\d+$/, "");
  return isLocalHostName(withoutPort);
}

export function localAuthBypassAllowed(hostHeader: string | null): boolean {
  return process.env.NODE_ENV !== "production" && isLocalHostHeader(hostHeader);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSignature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Constant-time string comparison over SHA-256 digests, so unequal lengths leak nothing. */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let difference = 0;
  for (let index = 0; index < bytesA.length; index += 1) {
    difference |= bytesA[index] ^ bytesB[index];
  }
  return difference === 0;
}

export async function createSessionToken(
  secret: string,
  expiresAtMs: number,
  credentialVersion: string | null = null,
): Promise<string> {
  const payload = credentialVersion
    ? `${PERSISTENT_TOKEN_VERSION}.${expiresAtMs}.${credentialVersion}`
    : `${BOOTSTRAP_TOKEN_VERSION}.${expiresAtMs}`;
  const signature = await hmacSignature(secret, `${SIGNING_CONTEXT}.${payload}`);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(
  token: string | null | undefined,
  secret: string | undefined,
  nowMs: number,
  requiredCredentialVersion?: string | null,
): Promise<boolean> {
  if (!token || !secret?.trim()) return false;
  const parts = token.split(".");
  const isBootstrap = parts.length === 3 && parts[0] === BOOTSTRAP_TOKEN_VERSION;
  const isPersistent = parts.length === 4 && parts[0] === PERSISTENT_TOKEN_VERSION;
  if (!isBootstrap && !isPersistent) return false;
  const expiresAtMs = Number(parts[1]);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
  const credentialVersion = isPersistent ? parts[2] : null;
  if (requiredCredentialVersion !== undefined) {
    if (requiredCredentialVersion === null && !isBootstrap) return false;
    if (requiredCredentialVersion !== null && credentialVersion !== requiredCredentialVersion) return false;
  }
  const expected = await createSessionToken(secret, expiresAtMs, credentialVersion);
  return timingSafeEqualStrings(token, expected);
}

export function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export async function verifyAccessCodeAndGetVersion(providedCode: string): Promise<{
  valid: boolean;
  credentialVersion: string | null;
}> {
  const env = authEnv();
  if (typeof providedCode !== "string") return { valid: false, credentialVersion: null };
  const persistent = await loadPasswordRecord();
  if (persistent) {
    return {
      valid: await verifyStoredPassword(providedCode, persistent),
      credentialVersion: persistent.credentialVersion,
    };
  }
  if (!env.ORGANISER_ACCESS_CODE?.trim()) return { valid: false, credentialVersion: null };
  return {
    valid: await timingSafeEqualStrings(providedCode, env.ORGANISER_ACCESS_CODE),
    credentialVersion: null,
  };
}

export async function verifyAccessCode(providedCode: string): Promise<boolean> {
  return (await verifyAccessCodeAndGetVersion(providedCode)).valid;
}

export async function issueSessionCookie(
  nowMs: number,
  credentialVersion?: string | null,
): Promise<string | null> {
  const env = authEnv();
  if (!authIsConfigured()) return null;
  const activeVersion =
    credentialVersion === undefined
      ? (await loadPasswordRecord())?.credentialVersion ?? null
      : credentialVersion;
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  const token = await createSessionToken(env.SESSION_SECRET as string, expiresAtMs, activeVersion);
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict; Secure`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`;
}

/**
 * The one auth question every protected surface asks: is this request from
 * localhost, or does it carry a valid session cookie?
 */
export async function requestIsAuthorized(args: {
  hostHeader: string | null;
  cookieHeader: string | null;
  nowMs?: number;
}): Promise<boolean> {
  if (localAuthBypassAllowed(args.hostHeader)) return true;
  const env = authEnv();
  const token = readCookieValue(args.cookieHeader, SESSION_COOKIE_NAME);
  try {
    const persistent = await loadPasswordRecord();
    return verifySessionToken(
      token,
      env.SESSION_SECRET,
      args.nowMs ?? Date.now(),
      persistent?.credentialVersion ?? null,
    );
  } catch {
    // If persistent credential storage is configured but unavailable or
    // malformed, never fall back to the bootstrap password/session.
    return false;
  }
}
