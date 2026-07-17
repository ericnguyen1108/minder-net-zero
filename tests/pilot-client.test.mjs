// Unit test for the pilot API transport helper. Mocks fetch, so it runs in the
// default suite with no server or database.

import assert from "node:assert/strict";
import test from "node:test";

import { pilot, PilotError, PilotAuthError, PilotConflictError } from "../app/pilot-client.ts";

function mockFetch(status, jsonBody, { throwNetwork = false, badJson = false } = {}) {
  return async (url, init) => {
    mockFetch.lastCall = { url, init };
    if (throwNetwork) throw new Error("offline");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (badJson) throw new Error("not json");
        return jsonBody;
      },
    };
  };
}

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test("posts the action+payload envelope and returns data on success", async () => {
  globalThis.fetch = mockFetch(200, { ok: true, data: { id: "r1" } });
  const data = await pilot("reviewers.add", { displayName: "Eric" });
  assert.deepEqual(data, { id: "r1" });
  const sent = JSON.parse(mockFetch.lastCall.init.body);
  assert.equal(mockFetch.lastCall.url, "/api/pilot");
  assert.equal(mockFetch.lastCall.init.method, "POST");
  assert.deepEqual(sent, { action: "reviewers.add", payload: { displayName: "Eric" } });
});

test("maps 401 to PilotAuthError", async () => {
  globalThis.fetch = mockFetch(401, { error: { code: "authentication_required", message: "Sign in." } });
  await assert.rejects(pilot("ranking.load"), (e) => {
    assert.ok(e instanceof PilotAuthError);
    assert.equal(e.code, "authentication_required");
    return true;
  });
});

test("maps 409 to PilotConflictError carrying the server code", async () => {
  globalThis.fetch = mockFetch(409, { error: { code: "already_revealed" } });
  await assert.rejects(pilot("calibration.reveal", {}), (e) => {
    assert.ok(e instanceof PilotConflictError);
    assert.equal(e.code, "already_revealed");
    return true;
  });
});

test("maps other error statuses to PilotError with the code", async () => {
  globalThis.fetch = mockFetch(400, { error: { code: "unknown_action", message: "nope" } });
  await assert.rejects(pilot("nope"), (e) => {
    assert.ok(e instanceof PilotError && !(e instanceof PilotConflictError) && !(e instanceof PilotAuthError));
    assert.equal(e.code, "unknown_action");
    assert.equal(e.message, "nope");
    return true;
  });
});

test("surfaces a network failure as a PilotError", async () => {
  globalThis.fetch = mockFetch(0, null, { throwNetwork: true });
  await assert.rejects(pilot("ranking.load"), (e) => {
    assert.ok(e instanceof PilotError);
    assert.equal(e.code, "network_error");
    return true;
  });
});

test("surfaces an unreadable body as a PilotError", async () => {
  globalThis.fetch = mockFetch(200, null, { badJson: true });
  await assert.rejects(pilot("ranking.load"), (e) => {
    assert.ok(e instanceof PilotError);
    assert.equal(e.code, "bad_response");
    return true;
  });
});
