const SAFE_CLERK_ID = /^(?:org|user)_[A-Za-z0-9_-]{6,120}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SAFE_NAME_MAX = 160;
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

export class OperatorInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperatorInputError";
  }
}

export function operationMode(argv) {
  const args = [...argv];
  if (args.length !== 1 || (args[0] !== "--dry-run" && args[0] !== "--apply")) {
    throw new OperatorInputError("Choose exactly one mode: --dry-run or --apply.");
  }
  return args[0] === "--apply" ? "apply" : "dry-run";
}

export function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new OperatorInputError(`${name} is required.`);
  return value;
}

export function validateDatabaseUrl(value, name = "database URL") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OperatorInputError(`${name} must be a valid PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new OperatorInputError(`${name} must use postgresql:// or postgres://.`);
  }
  if (!parsed.username || !parsed.password || parsed.pathname.length < 2) {
    throw new OperatorInputError(`${name} must include a role, password, and database name.`);
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (!local && !TLS_MODES.has(parsed.searchParams.get("sslmode"))) {
    throw new OperatorInputError(`${name} must require TLS with sslmode=require or stronger.`);
  }
  return Object.freeze({
    value,
    role: decodeURIComponent(parsed.username),
    hostname: parsed.hostname,
    database: decodeURIComponent(parsed.pathname.slice(1)),
  });
}

export function assertSeparateDatabaseRoles(admin, environment) {
  for (const name of ["DATABASE_URL", "IDENTITY_DATABASE_URL"]) {
    const candidate = environment[name]?.trim();
    if (!candidate) continue;
    const parsed = validateDatabaseUrl(candidate, name);
    if (parsed.role === admin.role) {
      throw new OperatorInputError(`${name} must not use the migration/administration role.`);
    }
  }
}

export function inferNeonDataRegion(hostname) {
  const parts = hostname.toLowerCase().split(".");
  if (parts.length < 5 || parts.at(-2) !== "neon" || parts.at(-1) !== "tech") return null;
  const provider = parts.at(-3);
  const region = parts.at(-4);
  if (!provider || !region || !/^[a-z0-9-]+$/.test(provider) || !/^[a-z0-9-]+$/.test(region)) {
    return null;
  }
  return `${provider}-${region}`;
}

export function validateClerkId(value, expectedPrefix, name) {
  if (!SAFE_CLERK_ID.test(value) || !value.startsWith(`${expectedPrefix}_`)) {
    throw new OperatorInputError(`${name} is not a valid Clerk ${expectedPrefix} ID.`);
  }
  return value;
}

export function validateSlug(value, name) {
  if (!SAFE_SLUG.test(value)) {
    throw new OperatorInputError(`${name} must be 2-63 lowercase letters, digits, or hyphens.`);
  }
  return value;
}

export function validateName(value, name) {
  const clean = value.trim();
  if (!clean || clean.length > SAFE_NAME_MAX || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new OperatorInputError(`${name} must be 1-${SAFE_NAME_MAX} printable characters.`);
  }
  return clean;
}

export function validateRegion(value) {
  if (!SAFE_REGION.test(value)) {
    throw new OperatorInputError("MINDER_DATA_REGION must be a documented lowercase region code.");
  }
  return value;
}

export function validateTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    throw new OperatorInputError("MINDER_COMPETITION_TIMEZONE must be an IANA timezone.");
  }
  return value;
}

export function requireExactConfirmation(environment, name, expected) {
  if (environment[name] !== expected) {
    throw new OperatorInputError(`${name} must be set to ${expected} before this operation.`);
  }
}

export function validateSecretKey(value, deploymentEnvironment) {
  if (!/^sk_(?:live|test)_[A-Za-z0-9_-]{12,}$/.test(value)) {
    throw new OperatorInputError("CLERK_SECRET_KEY is not shaped like a Clerk secret key.");
  }
  if (deploymentEnvironment === "production" && !value.startsWith("sk_live_")) {
    throw new OperatorInputError("Production provisioning requires a Clerk production secret key.");
  }
  return value;
}

export function validateDeploymentEnvironment(value) {
  if (value !== "production" && value !== "staging") {
    throw new OperatorInputError("MINDER_DEPLOYMENT_ENV must be production or staging.");
  }
  return value;
}

export function safeFailureMessage(error) {
  if (error instanceof OperatorInputError) return error.message;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const safeCode = /^[A-Z0-9_]{2,24}$/.test(code) ? ` (${code})` : "";
  return `The operation stopped safely${safeCode}. No secret values were printed.`;
}
