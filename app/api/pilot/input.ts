const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replacement ids can come from browser state created before the Postgres
 * migration. Those legacy ids use a `history-...`/`current-...` prefix and
 * must never be interpolated into a PostgreSQL uuid comparison.
 */
export function optionalDatabaseUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}
