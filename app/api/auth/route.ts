import {
  authIsConfigured,
  clearSessionCookie,
  localAuthBypassAllowed,
  issueSessionCookie,
  requestIsAuthorized,
  verifyAccessCodeAndGetVersion,
} from "../../auth.ts";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordStoreIsConfigured,
  savePassword,
} from "../../auth-store.ts";

const MAX_SIGNIN_ATTEMPTS = 10;
const SIGNIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 4_096;

function legacyAuthUnavailable(): Response | null {
  if (process.env.AUTH_MODE !== "clerk") return null;
  return json(
    {
      error: {
        code: "legacy_auth_disabled",
        message: "This deployment uses individual accounts. Use the account sign-in page.",
      },
    },
    404,
  );
}

/**
 * Per-instance sliding window. On serverless this only bounds one warm
 * instance, so it is a brake on casual brute force, not a hard guarantee —
 * the real defence is the high-entropy access code.
 */
const signInAttempts = new Map<string, { count: number; resetAtMs: number }>();

function clientKey(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function signInRateLimited(request: Request, nowMs: number): boolean {
  const key = clientKey(request);
  const entry = signInAttempts.get(key);
  if (!entry || entry.resetAtMs <= nowMs) {
    signInAttempts.set(key, { count: 1, resetAtMs: nowMs + SIGNIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_SIGNIN_ATTEMPTS;
}

function json(value: unknown, status: number, extraHeaders?: Record<string, string>) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === "same-origin" || localAuthBypassAllowed(request.headers.get("host"));
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_BYTES) return null;
  const parsed: unknown = JSON.parse(bodyText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export async function GET(request: Request) {
  const unavailable = legacyAuthUnavailable();
  if (unavailable) return unavailable;
  const authorized = await requestIsAuthorized({
    hostHeader: request.headers.get("host"),
    cookieHeader: request.headers.get("cookie"),
    nowMs: Date.now(),
  });
  return json(
    {
      authenticated: authorized,
      configured: authIsConfigured(),
      passwordChangeAvailable: passwordStoreIsConfigured(),
    },
    200,
  );
}

export async function POST(request: Request) {
  const unavailable = legacyAuthUnavailable();
  if (unavailable) return unavailable;
  const nowMs = Date.now();
  if (localAuthBypassAllowed(request.headers.get("host"))) {
    return json({ authenticated: true }, 200);
  }
  if (!authIsConfigured()) {
    return json(
      {
        error: {
          code: "auth_not_configured",
          message:
            "Sign-in is not set up yet. An administrator must configure ORGANISER_ACCESS_CODE and SESSION_SECRET.",
        },
      },
      503,
    );
  }
  if (signInRateLimited(request, nowMs)) {
    return json(
      { error: { code: "too_many_attempts", message: "Too many attempts. Try again in a few minutes." } },
      429,
    );
  }

  let accessCode = "";
  try {
    const parsed = await readJsonObject(request);
    if (!parsed) throw new Error("invalid");
    const candidate = parsed.accessCode;
    if (typeof candidate === "string") accessCode = candidate;
  } catch {
    return json({ error: { code: "invalid_request", message: "Send the password as JSON." } }, 400);
  }

  let verification: Awaited<ReturnType<typeof verifyAccessCodeAndGetVersion>>;
  try {
    verification = await verifyAccessCodeAndGetVersion(accessCode);
  } catch {
    return json(
      {
        error: {
          code: "auth_store_unavailable",
          message: "Sign-in is temporarily unavailable. Try again shortly.",
        },
      },
      503,
    );
  }
  if (!verification.valid) {
    return json(
      { error: { code: "invalid_access_code", message: "That password is not correct." } },
      401,
    );
  }

  const cookie = await issueSessionCookie(nowMs, verification.credentialVersion);
  if (!cookie) {
    return json({ error: { code: "auth_not_configured", message: "Sign-in is not set up yet." } }, 503);
  }
  return json({ authenticated: true }, 200, { "Set-Cookie": cookie });
}

export async function PATCH(request: Request) {
  const unavailable = legacyAuthUnavailable();
  if (unavailable) return unavailable;
  const nowMs = Date.now();
  if (!sameOriginMutation(request)) {
    return json({ error: { code: "forbidden_origin", message: "Request rejected." } }, 403);
  }
  const authorized = await requestIsAuthorized({
    hostHeader: request.headers.get("host"),
    cookieHeader: request.headers.get("cookie"),
    nowMs,
  });
  if (!authorized) {
    return json({ error: { code: "not_authenticated", message: "Sign in again to continue." } }, 401);
  }
  if (!passwordStoreIsConfigured()) {
    return json(
      {
        error: {
          code: "password_store_not_configured",
          message: "Password changes are not enabled on this deployment yet.",
        },
      },
      503,
    );
  }
  if (signInRateLimited(request, nowMs)) {
    return json(
      { error: { code: "too_many_attempts", message: "Too many attempts. Try again in a few minutes." } },
      429,
    );
  }

  let currentPassword = "";
  let newPassword = "";
  try {
    const parsed = await readJsonObject(request);
    if (!parsed) throw new Error("invalid");
    if (typeof parsed.currentPassword === "string") currentPassword = parsed.currentPassword;
    if (typeof parsed.newPassword === "string") newPassword = parsed.newPassword;
  } catch {
    return json({ error: { code: "invalid_request", message: "Enter both passwords." } }, 400);
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
    return json(
      {
        error: {
          code: "weak_password",
          message: `Use ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters for the new password.`,
        },
      },
      400,
    );
  }

  let verification: Awaited<ReturnType<typeof verifyAccessCodeAndGetVersion>>;
  try {
    verification = await verifyAccessCodeAndGetVersion(currentPassword);
  } catch {
    return json(
      { error: { code: "auth_store_unavailable", message: "Password change is temporarily unavailable." } },
      503,
    );
  }
  if (!verification.valid) {
    return json(
      { error: { code: "invalid_current_password", message: "Your current password is not correct." } },
      401,
    );
  }

  let samePassword: Awaited<ReturnType<typeof verifyAccessCodeAndGetVersion>>;
  try {
    samePassword = await verifyAccessCodeAndGetVersion(newPassword);
  } catch {
    return json(
      { error: { code: "auth_store_unavailable", message: "Password change is temporarily unavailable." } },
      503,
    );
  }
  if (samePassword.valid) {
    return json(
      { error: { code: "password_unchanged", message: "Choose a password you have not just used." } },
      400,
    );
  }

  try {
    const record = await savePassword(newPassword, new Date(nowMs));
    const cookie = await issueSessionCookie(nowMs, record.credentialVersion);
    if (!cookie) throw new Error("auth_not_configured");
    return json(
      {
        authenticated: true,
        message: "Password changed. Other signed-in sessions have been securely signed out.",
      },
      200,
      { "Set-Cookie": cookie },
    );
  } catch {
    return json(
      { error: { code: "password_store_unavailable", message: "Could not save the new password." } },
      503,
    );
  }
}

export async function DELETE() {
  const unavailable = legacyAuthUnavailable();
  if (unavailable) return unavailable;
  return json({ authenticated: false }, 200, { "Set-Cookie": clearSessionCookie() });
}
