export const PRODUCTION_AUTH_MODE = "clerk" as const;

export type ReadinessCheckStatus = "ok" | "failed" | "skipped";

export type ReadinessResult = Readonly<{
  ready: boolean;
  checks: Readonly<{
    authenticationConfiguration: ReadinessCheckStatus;
    databaseConnectivity: ReadinessCheckStatus;
    identitySyncConnectivity: ReadinessCheckStatus;
  }>;
}>;

export function explicitProductionAuthConfigured(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === PRODUCTION_AUTH_MODE;
}

export function isPlatformAdministratorRoleSet(roles: readonly unknown[]): boolean {
  return roles.includes("owner") || roles.includes("competition_admin");
}

async function probeWithinTimeout(
  databaseProbe: () => Promise<unknown>,
  timeoutMs: number,
): Promise<"ok" | "failed"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<"failed">((resolve) => {
    timeout = setTimeout(() => resolve("failed"), timeoutMs);
    timeout.unref?.();
  });
  const probeResult: Promise<"ok" | "failed"> = Promise.resolve()
    .then(databaseProbe)
    .then(() => "ok" as const)
    .catch(() => "failed" as const);

  try {
    return await Promise.race([probeResult, timeoutResult]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Returns only categorical health state. Probe exceptions, connection strings,
 * provider identifiers, and database error messages must never reach callers.
 */
export async function runReadinessChecks(input: {
  authMode: string | undefined;
  databaseProbe: () => Promise<unknown>;
  identityDatabaseProbe: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<ReadinessResult> {
  if (!explicitProductionAuthConfigured(input.authMode)) {
    return {
      ready: false,
      checks: {
        authenticationConfiguration: "failed",
        databaseConnectivity: "skipped",
        identitySyncConnectivity: "skipped",
      },
    };
  }

  const timeoutMs = Math.max(50, Math.min(input.timeoutMs ?? 2_500, 10_000));
  const [databaseConnectivity, identitySyncConnectivity] = await Promise.all([
    probeWithinTimeout(input.databaseProbe, timeoutMs),
    probeWithinTimeout(input.identityDatabaseProbe, timeoutMs),
  ]);
  return {
    ready: databaseConnectivity === "ok" && identitySyncConnectivity === "ok",
    checks: {
      authenticationConfiguration: "ok",
      databaseConnectivity,
      identitySyncConnectivity,
    },
  };
}
