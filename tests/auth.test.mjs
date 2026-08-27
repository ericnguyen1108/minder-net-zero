import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createSessionToken,
  isLocalHostHeader,
  readCookieValue,
  requestIsAuthorized,
  verifySessionToken,
} from "../app/auth.ts";
import {
  DELETE as authDelete,
  GET as authGet,
  PATCH as authPatch,
  POST as authPost,
} from "../app/api/auth/route.ts";

const SECRET = "test-session-secret-please-rotate";

function withAuthEnv(run) {
  const previousAuthMode = process.env.AUTH_MODE;
  const previousCode = process.env.ORGANISER_ACCESS_CODE;
  const previousSecret = process.env.SESSION_SECRET;
  const previousStoreUrl = process.env.AUTH_KV_REST_API_URL;
  const previousStoreToken = process.env.AUTH_KV_REST_API_TOKEN;
  const previousStoredPasswordRequired = process.env.AUTH_STORED_PASSWORD_REQUIRED;
  process.env.ORGANISER_ACCESS_CODE = "correct-horse-battery";
  process.env.SESSION_SECRET = SECRET;
  delete process.env.AUTH_KV_REST_API_URL;
  delete process.env.AUTH_KV_REST_API_TOKEN;
  delete process.env.AUTH_STORED_PASSWORD_REQUIRED;
  delete process.env.AUTH_MODE;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previousCode === undefined) delete process.env.ORGANISER_ACCESS_CODE;
      else process.env.ORGANISER_ACCESS_CODE = previousCode;
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
      if (previousStoreUrl === undefined) delete process.env.AUTH_KV_REST_API_URL;
      else process.env.AUTH_KV_REST_API_URL = previousStoreUrl;
      if (previousStoreToken === undefined) delete process.env.AUTH_KV_REST_API_TOKEN;
      else process.env.AUTH_KV_REST_API_TOKEN = previousStoreToken;
      if (previousStoredPasswordRequired === undefined) delete process.env.AUTH_STORED_PASSWORD_REQUIRED;
      else process.env.AUTH_STORED_PASSWORD_REQUIRED = previousStoredPasswordRequired;
      if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousAuthMode;
    });
}

test("legacy shared-password routes are unavailable after the individual-account cutover", async () => {
  const previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "clerk";
  try {
    const request = new Request("https://minder.example/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: "legacy-code" }),
    });
    const response = await authPost(request);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "legacy_auth_disabled");
  } finally {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
  }
});

test("session tokens verify only with the right secret, unexpired, untampered", async () => {
  const now = 1_700_000_000_000;
  const token = await createSessionToken(SECRET, now + SESSION_TTL_MS);

  assert.equal(await verifySessionToken(token, SECRET, now), true);
  assert.equal(await verifySessionToken(token, "other-secret", now), false);
  assert.equal(await verifySessionToken(token, SECRET, now + SESSION_TTL_MS + 1), false);
  assert.equal(await verifySessionToken(`${token}x`, SECRET, now), false);
  const [version, expiry, signature] = token.split(".");
  assert.equal(await verifySessionToken(`${version}.${Number(expiry) + 9999}.${signature}`, SECRET, now), false);
  assert.equal(await verifySessionToken(null, SECRET, now), false);
  assert.equal(await verifySessionToken(token, undefined, now), false);
});

test("request authorization: localhost bypass, valid cookie, garbage cookie", async () => {
  await withAuthEnv(async () => {
    const now = Date.now();
    const token = await createSessionToken(SECRET, now + 60_000);

    assert.equal(
      await requestIsAuthorized({ hostHeader: "localhost:3000", cookieHeader: null, nowMs: now }),
      true,
    );
    assert.equal(
      await requestIsAuthorized({
        hostHeader: "minder.example",
        cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
        nowMs: now,
      }),
      true,
    );
    assert.equal(
      await requestIsAuthorized({
        hostHeader: "minder.example",
        cookieHeader: `${SESSION_COOKIE_NAME}=not-a-real-token`,
        nowMs: now,
      }),
      false,
    );
    assert.equal(
      await requestIsAuthorized({ hostHeader: "minder.example", cookieHeader: null, nowMs: now }),
      false,
    );
  });

  assert.equal(isLocalHostHeader("localhost"), true);
  assert.equal(isLocalHostHeader("127.0.0.1:3000"), true);
  assert.equal(isLocalHostHeader("[::1]:3000"), true);
  assert.equal(isLocalHostHeader("minder-net-zero.vercel.app"), false);
  assert.equal(isLocalHostHeader("evil-localhost.example"), false);
  assert.equal(readCookieValue("a=1; minder_session=abc; b=2", "minder_session"), "abc");
  assert.equal(readCookieValue(null, "minder_session"), null);
});

test("auth route exchanges the correct code for a session cookie and rejects wrong codes", async () => {
  await withAuthEnv(async () => {
    const wrong = await authPost(
      new Request("https://minder.example/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "wrong-code" }),
      }),
    );
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);

    const right = await authPost(
      new Request("https://minder.example/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "correct-horse-battery" }),
      }),
    );
    assert.equal(right.status, 200);
    const setCookie = right.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /minder_session=v1\./);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);

    const token = readCookieValue(setCookie.split(";")[0], SESSION_COOKIE_NAME);
    assert.equal(await verifySessionToken(token, SECRET, Date.now()), true);

    const status = await authGet(
      new Request("https://minder.example/api/auth", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
    assert.deepEqual(await status.json(), {
      authenticated: true,
      configured: true,
      passwordChangeAvailable: false,
    });

    const signedOut = await authDelete();
    assert.match(signedOut.headers.get("set-cookie") ?? "", /minder_session=;.*Max-Age=0/);
  });
});

test("changing the password replaces the bootstrap password and invalidates old sessions", async () => {
  await withAuthEnv(async () => {
    process.env.AUTH_KV_REST_API_URL = "https://auth-store.example";
    process.env.AUTH_KV_REST_API_TOKEN = "test-store-token";
    const originalFetch = globalThis.fetch;
    let storedValue = null;
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.headers?.authorization, "Bearer test-store-token");
      assert.ok(init?.signal instanceof AbortSignal);
      const command = JSON.parse(String(init?.body));
      if (command[0] === "GET") return Response.json({ result: storedValue });
      if (command[0] === "SET") {
        storedValue = command[2];
        return Response.json({ result: "OK" });
      }
      return Response.json({ error: "unsupported" }, { status: 400 });
    };

    try {
      const initialLogin = await authPost(
        new Request("https://minder.example/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
          body: JSON.stringify({ accessCode: "correct-horse-battery" }),
        }),
      );
      assert.equal(initialLogin.status, 200);
      const initialToken = readCookieValue(
        (initialLogin.headers.get("set-cookie") ?? "").split(";")[0],
        SESSION_COOKIE_NAME,
      );
      assert.match(initialToken ?? "", /^v1\./);

      const changed = await authPatch(
        new Request("https://minder.example/api/auth", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: `${SESSION_COOKIE_NAME}=${initialToken}`,
            origin: "https://minder.example",
            "x-forwarded-for": "203.0.113.20",
          },
          body: JSON.stringify({
            currentPassword: "correct-horse-battery",
            newPassword: "a-new-long-password-2026",
          }),
        }),
      );
      assert.equal(changed.status, 200);
      assert.ok(storedValue);
      assert.doesNotMatch(storedValue, /a-new-long-password-2026|correct-horse-battery/);
      const record = JSON.parse(storedValue);
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.iterations, 310_000);

      const replacementToken = readCookieValue(
        (changed.headers.get("set-cookie") ?? "").split(";")[0],
        SESSION_COOKIE_NAME,
      );
      assert.match(replacementToken ?? "", /^v2\./);

      const oldSessionStatus = await authGet(
        new Request("https://minder.example/api/auth", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${initialToken}` },
        }),
      );
      assert.equal((await oldSessionStatus.json()).authenticated, false);

      const newSessionStatus = await authGet(
        new Request("https://minder.example/api/auth", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${replacementToken}` },
        }),
      );
      assert.equal((await newSessionStatus.json()).authenticated, true);

      const oldPasswordLogin = await authPost(
        new Request("https://minder.example/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.21" },
          body: JSON.stringify({ accessCode: "correct-horse-battery" }),
        }),
      );
      assert.equal(oldPasswordLogin.status, 401);

      const newPasswordLogin = await authPost(
        new Request("https://minder.example/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.21" },
          body: JSON.stringify({ accessCode: "a-new-long-password-2026" }),
        }),
      );
      assert.equal(newPasswordLogin.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a required stored password fails closed if its Redis record disappears", async () => {
  await withAuthEnv(async () => {
    process.env.AUTH_KV_REST_API_URL = "https://auth-store.example";
    process.env.AUTH_KV_REST_API_TOKEN = "test-store-token";
    process.env.AUTH_STORED_PASSWORD_REQUIRED = "true";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ result: null });
    try {
      const bootstrapLogin = await authPost(
        new Request("https://minder.example/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessCode: "correct-horse-battery" }),
        }),
      );
      assert.equal(bootstrapLogin.status, 401);

      const oldBootstrapToken = await createSessionToken(SECRET, Date.now() + 60_000);
      assert.equal(
        await requestIsAuthorized({
          hostHeader: "minder.example",
          cookieHeader: `${SESSION_COOKIE_NAME}=${oldBootstrapToken}`,
        }),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a required stored password fails closed if its Redis configuration disappears", async () => {
  await withAuthEnv(async () => {
    process.env.AUTH_STORED_PASSWORD_REQUIRED = "true";
    const bootstrapLogin = await authPost(
      new Request("https://minder.example/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "correct-horse-battery" }),
      }),
    );
    assert.equal(bootstrapLogin.status, 503);
    assert.equal((await bootstrapLogin.json()).error.code, "auth_not_configured");

    const oldBootstrapToken = await createSessionToken(SECRET, Date.now() + 60_000);
    assert.equal(
      await requestIsAuthorized({
        hostHeader: "minder.example",
        cookieHeader: `${SESSION_COOKIE_NAME}=${oldBootstrapToken}`,
      }),
      false,
    );
  });
});

test("password change requires authentication, same-origin request, and persistent storage", async () => {
  await withAuthEnv(async () => {
    const unauthenticated = await authPatch(
      new Request("https://minder.example/api/auth", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "https://minder.example" },
        body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "new-password-1234" }),
      }),
    );
    assert.equal(unauthenticated.status, 401);

    const token = await createSessionToken(SECRET, Date.now() + 60_000);
    const crossSite = await authPatch(
      new Request("https://minder.example/api/auth", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "new-password-1234" }),
      }),
    );
    assert.equal(crossSite.status, 403);

    const noStore = await authPatch(
      new Request("https://minder.example/api/auth", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
          origin: "https://minder.example",
        },
        body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "new-password-1234" }),
      }),
    );
    assert.equal(noStore.status, 503);
    assert.equal((await noStore.json()).error.code, "password_store_not_configured");
  });
});

test("auth route fails closed when the deployment is not configured", async () => {
  const previousCode = process.env.ORGANISER_ACCESS_CODE;
  const previousSecret = process.env.SESSION_SECRET;
  delete process.env.ORGANISER_ACCESS_CODE;
  delete process.env.SESSION_SECRET;
  try {
    const response = await authPost(
      new Request("https://minder.example/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "anything" }),
      }),
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "auth_not_configured");
  } finally {
    if (previousCode !== undefined) process.env.ORGANISER_ACCESS_CODE = previousCode;
    if (previousSecret !== undefined) process.env.SESSION_SECRET = previousSecret;
  }
});
