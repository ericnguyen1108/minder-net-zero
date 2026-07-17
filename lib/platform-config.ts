export type PlatformAuthMode = "legacy" | "clerk" | "unconfigured";

export type PlatformConfiguration = {
  authMode: PlatformAuthMode;
  clerkReady: boolean;
  databaseReady: boolean;
  ready: boolean;
  missing: string[];
};

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * The production platform is an explicit cutover. Merely adding one secret
 * must never silently replace the working pilot authentication.
 */
export function platformAuthMode(): PlatformAuthMode {
  const configured = clean(process.env.AUTH_MODE).toLowerCase();
  if (configured === "clerk") return "clerk";
  if (configured === "legacy") {
    if (
      process.env.NODE_ENV === "production" &&
      clean(process.env.ALLOW_LEGACY_PRODUCTION).toLowerCase() !== "true"
    ) return "unconfigured";
    return "legacy";
  }
  // Local development remains convenient, but a deployed production build
  // never guesses which authentication boundary the operator intended.
  return process.env.NODE_ENV === "production" ? "unconfigured" : "legacy";
}

export function platformConfiguration(): PlatformConfiguration {
  const authMode = platformAuthMode();
  const missing: string[] = [];

  if (authMode === "unconfigured") {
    missing.push("AUTH_MODE=clerk");
  }

  if (authMode === "clerk") {
    if (clean(process.env.NEXT_PUBLIC_AUTH_MODE).toLowerCase() !== "clerk") {
      missing.push("NEXT_PUBLIC_AUTH_MODE=clerk");
    }
    if (!clean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)) {
      missing.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    }
    if (!clean(process.env.CLERK_SECRET_KEY)) missing.push("CLERK_SECRET_KEY");
    if (!clean(process.env.CLERK_WEBHOOK_SIGNING_SECRET)) {
      missing.push("CLERK_WEBHOOK_SIGNING_SECRET");
    }
    if (!clean(process.env.DATABASE_URL)) missing.push("DATABASE_URL");
    if (!clean(process.env.IDENTITY_DATABASE_URL)) missing.push("IDENTITY_DATABASE_URL");
  }

  const clerkReady =
    authMode === "clerk" &&
    clean(process.env.NEXT_PUBLIC_AUTH_MODE).toLowerCase() === "clerk" &&
    Boolean(clean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)) &&
    Boolean(clean(process.env.CLERK_SECRET_KEY)) &&
    Boolean(clean(process.env.CLERK_WEBHOOK_SIGNING_SECRET)) &&
    Boolean(clean(process.env.IDENTITY_DATABASE_URL));
  const databaseReady = Boolean(clean(process.env.DATABASE_URL));

  return {
    authMode,
    clerkReady,
    databaseReady,
    ready: authMode === "legacy" || (authMode === "clerk" && clerkReady && databaseReady),
    missing,
  };
}

export function productionPlatformEnabled(): boolean {
  const config = platformConfiguration();
  return config.authMode === "clerk" && config.ready;
}
