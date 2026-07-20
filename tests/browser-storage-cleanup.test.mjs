import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";
import {
  LEGACY_CANDIDATE_DATABASE,
  deleteLegacyCandidateDatabase,
} from "../app/browser-storage-cleanup.ts";

globalThis.indexedDB = indexedDB;

function openLegacyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_CANDIDATE_DATABASE, 6);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("current-identities", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("deletes the obsolete candidate-data IndexedDB after central hydration", async () => {
  const database = await openLegacyDatabase();
  database.close();
  assert.equal(await deleteLegacyCandidateDatabase(), "deleted");

  let recreatedFromZero = false;
  const reopened = await new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_CANDIDATE_DATABASE, 1);
    request.onupgradeneeded = (event) => {
      recreatedFromZero = event.oldVersion === 0;
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  reopened.close();
  assert.equal(recreatedFromZero, true);
  await deleteLegacyCandidateDatabase();
});
