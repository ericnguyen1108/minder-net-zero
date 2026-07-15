import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Minder Net Zero setup experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Minder Net Zero<\/title>/i);
  assert.match(html, /Competition setup/);
  assert.match(html, /Prepare a trustworthy assessment/);
  assert.match(html, /Minder recommends\. People decide\./);
  assert.match(html, /Assessment is off/);
  assert.match(html, /Build your decision guide/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("removes starter assets and keeps the safety language", async () => {
  const [page, historyImport, historyData, historyParser, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/historical-import.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/historical-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/historical-parser.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Minder cannot make a final shortlist or rejection on its own/);
  assert.match(page, /Nothing is used without approval/);
  assert.match(page, /Rules first, patterns later/);
  assert.match(page, /weightsTotal === 100/);
  assert.match(page, /missingInformationAcknowledged/);
  assert.match(page, /A person confirms every outcome/);
  assert.match(page, /rules: \[\]/);
  assert.doesNotMatch(page, /fetch\(|OPENAI_API_KEY|api\.openai\.com/);
  assert.match(historyImport, /No AI in this step/);
  assert.match(historyImport, /not uploaded or sent to AI/);
  assert.match(historyData, /historical-teaching/);
  assert.match(historyData, /historical-sealed/);
  assert.match(historyData, /historical-active/);
  assert.match(historyData, /did not pass its integrity check/);
  assert.doesNotMatch(`${historyImport}\n${historyData}\n${historyParser}`, /fetch\(|OPENAI_API_KEY|api\.openai\.com/);
  assert.match(layout, /fair, evidence-backed application review/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|site-creator-vinext-starter/);

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../.openai/hosting.json", import.meta.url));
  await access(root);
});

test("implements Phase 4 while keeping later assessment capabilities locked", async () => {
  const [page, phase4, storage] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4-storage.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /type="button" disabled>[\s\S]{0,120}>02<\/span>Applications/);
  assert.match(page, /type="button" disabled>[\s\S]{0,120}>03<\/span>Review/);
  assert.match(page, /type="button" disabled>[\s\S]{0,120}>04<\/span>Results/);
  assert.match(page, /Minder can only recommend that the application does not progress/);
  assert.match(page, /Missing or conflicting evidence always goes to Human Review/);
  assert.match(page, /type ActiveView = "overview" \| "details" \| "guide" \| "history" \| "learning"/);
  assert.match(page, /step\.number === 4 && historyReady/);
  assert.match(page, /step\.number === 5 && teachingApproved/);
  assert.match(page, /historyStorageState === "verified"/);
  assert.match(phase4, /AI service not connected/);
  assert.match(phase4, /Historical agreement is not truth/);
  assert.match(phase4, /Approve for supervised pilot/);
  assert.match(phase4, /Human relevance check/);
  assert.match(phase4, /validateAiAssessmentBatch/);
  assert.match(storage, /predictions_committed/);
  assert.match(storage, /PHASE4_CONSUMED_STORE, SEALED_STORE/);
  assert.match(storage, /one-use reveal/);
  assert.doesNotMatch(storage, /loadCompleteSealedOutcomeKey/);
});
