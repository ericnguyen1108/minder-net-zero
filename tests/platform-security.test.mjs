import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_PLATFORM_BODY_BYTES,
  platformJson,
  readPlatformJson,
  requestId,
  sameOriginMutation,
} from "../lib/http-security.ts";

function mutationRequest(headers = {}) {
  return new Request("https://minder.example/api/platform/test", {
    method: "POST",
    headers,
    body: "{}",
  });
}

test("same-origin mutation checks fail closed outside trusted browser and local-dev contexts", () => {
  assert.equal(
    sameOriginMutation(mutationRequest({ origin: "https://minder.example" })),
    true,
  );
  assert.equal(
    sameOriginMutation(mutationRequest({ origin: "HTTPS://MINDER.EXAMPLE:443/" })),
    true,
  );
  assert.equal(
    sameOriginMutation(mutationRequest({ origin: "https://attacker.example" })),
    false,
  );
  assert.equal(sameOriginMutation(mutationRequest({ origin: "null" })), false);
  assert.equal(
    sameOriginMutation(mutationRequest({ "sec-fetch-site": "same-origin" })),
    true,
  );
  assert.equal(
    sameOriginMutation(mutationRequest({ "sec-fetch-site": "cross-site" })),
    false,
  );

  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    assert.equal(
      sameOriginMutation(
        new Request("http://localhost:3000/api/platform/test", {
          method: "POST",
          headers: { host: "localhost:3000" },
          body: "{}",
        }),
      ),
      true,
    );
    process.env.NODE_ENV = "production";
    assert.equal(
      sameOriginMutation(
        new Request("http://localhost:3000/api/platform/test", {
          method: "POST",
          headers: { host: "localhost:3000" },
          body: "{}",
        }),
      ),
      false,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("platform JSON reader enforces its limit in UTF-8 bytes while streaming", async () => {
  const prefix = '{"value":"';
  const suffix = '"}';
  const framingBytes = new TextEncoder().encode(prefix + suffix).byteLength;
  const exact = `${prefix}${"a".repeat(MAX_PLATFORM_BODY_BYTES - framingBytes)}${suffix}`;
  assert.equal(new TextEncoder().encode(exact).byteLength, MAX_PLATFORM_BODY_BYTES);
  const parsed = await readPlatformJson(
    new Request("https://minder.example/api/platform/test", { method: "POST", body: exact }),
  );
  assert.equal(parsed.value.length, MAX_PLATFORM_BODY_BYTES - framingBytes);

  const oneByteOver = `${prefix}${"a".repeat(MAX_PLATFORM_BODY_BYTES - framingBytes + 1)}${suffix}`;
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        body: oneByteOver,
      }),
    ),
    /body_too_large/,
  );

  const multibyte = `${prefix}${"界".repeat(11_000)}${suffix}`;
  assert.ok(multibyte.length < MAX_PLATFORM_BODY_BYTES, "character-count check would miss this");
  assert.ok(new TextEncoder().encode(multibyte).byteLength > MAX_PLATFORM_BODY_BYTES);
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        body: multibyte,
      }),
    ),
    /body_too_large/,
  );
});

test("platform JSON reader distrusts declared lengths, encodings, malformed UTF-8 and non-objects", async () => {
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        headers: { "content-length": String(MAX_PLATFORM_BODY_BYTES + 1) },
        body: "{}",
      }),
    ),
    /body_too_large/,
  );
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        headers: { "content-length": "1" },
        body: "{}",
      }),
    ),
    /invalid_content_length/,
  );
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        headers: { "content-length": "-1" },
        body: "{}",
      }),
    ),
    /invalid_content_length/,
  );
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: "{}",
      }),
    ),
    /unsupported_content_encoding/,
  );
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        body: new Uint8Array([0xff]),
      }),
    ),
    /invalid_json/,
  );
  await assert.rejects(
    readPlatformJson(
      new Request("https://minder.example/api/platform/test", {
        method: "POST",
        body: "[]",
      }),
    ),
    /invalid_json/,
  );
});

test("platform responses and request IDs use non-cacheable, non-sniffable safe values", async () => {
  const response = platformJson({ ok: true });
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(await response.json(), { ok: true });

  assert.equal(
    requestId(
      new Request("https://minder.example", { headers: { "x-request-id": "iad1::safe-123" } }),
    ),
    "iad1::safe-123",
  );
  assert.match(
    requestId(
      new Request("https://minder.example", { headers: { "x-request-id": "unsafe request id" } }),
    ),
    /^[0-9a-f-]{36}$/,
  );
});

test("every platform mutation route applies origin and bounded-body helpers before work", async () => {
  const [membersRoute, reviewRoute] = await Promise.all([
    readFile(new URL("../app/api/platform/members/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/platform/reviews/[assignmentId]/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.equal((membersRoute.match(/sameOriginMutation\(request\)/g) ?? []).length, 2);
  assert.equal((membersRoute.match(/readPlatformJson\(request\)/g) ?? []).length, 2);
  assert.equal((reviewRoute.match(/sameOriginMutation\(request\)/g) ?? []).length, 1);
  assert.equal((reviewRoute.match(/readPlatformJson\(request\)/g) ?? []).length, 1);
  assert.doesNotMatch(reviewRoute, /metadata:\s*\{[^}]*notes/s);
});
