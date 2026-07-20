/** The pre-Postgres candidate-data database. No current code may reopen it. */
export const LEGACY_CANDIDATE_DATABASE = "minder-net-zero-private-v1";

export type LegacyDatabaseCleanup = "deleted" | "blocked" | "unavailable";

/**
 * Removes stale local copies only after the caller has verified that the
 * central historical/current services are reachable. A tab still using the
 * old database blocks deletion rather than being forced closed.
 */
export function deleteLegacyCandidateDatabase(): Promise<LegacyDatabaseCleanup> {
  if (typeof indexedDB === "undefined") return Promise.resolve("unavailable");
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LEGACY_CANDIDATE_DATABASE);
    request.onsuccess = () => resolve("deleted");
    request.onblocked = () => resolve("blocked");
    request.onerror = () =>
      reject(request.error ?? new Error("The old browser database could not be removed."));
  });
}
