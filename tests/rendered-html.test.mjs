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

test("implements Phase 5 while keeping final decisions and exports locked", async () => {
  const [page, phase4, storage, phase5, phase5Storage, currentImport, currentData, phase5Api] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/phase5.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase5-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/current-import.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/current-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/phase5/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /disabled={!safeguardsApproved} onClick={openApplications}/);
  assert.match(page, /disabled={!currentReady} onClick={openAssessment}/);
  assert.match(page, /type="button" disabled>[\s\S]{0,120}>04<\/span>Results/);
  assert.match(page, /Minder can only recommend that the application does not progress/);
  assert.match(page, /Missing or conflicting evidence always goes to Human Review/);
  assert.match(page, /\| "safeguards"/);
  assert.match(page, /\| "applications"/);
  assert.match(page, /\| "assessment"/);
  assert.match(page, /step\.number === 4 && historyReady/);
  assert.match(page, /step\.number === 5 && teachingApproved/);
  assert.match(page, /step\.number === 6 && practicePassed/);
  assert.match(page, /step\.number === 7 && safeguardsApproved/);
  assert.match(page, /step\.number === 8 && currentReady/);
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
  assert.match(phase5, /Passing a practice test does not make AI infallible/);
  assert.match(phase5, /117 AI requests/);
  assert.match(phase5, /Exact text proves the quotation exists/);
  assert.doesNotMatch(phase5, /findings\.slice\(0,\s*5\)/);
  assert.match(phase5, /findings\.map\(/);
  assert.match(phase5, /finding\.evidence\.map\(/);
  assert.match(phase5, /Every evidence-bearing finding is shown/);
  assert.match(phase5, /Minder will not retry the same configuration/);
  assert.match(phase5, /Create fresh supervised run/);
  assert.match(phase5, /phase5RecoveryInputsDiffer/);
  assert.match(page, /assessmentStarted={Boolean\(phase5Run\)}/);
  assert.match(page, /assessmentInvalid={phase5Run\?\.status === "invalid"}/);
  assert.match(page, /onSupersededDataset={\(\) => setPhase5Run\(null\)}/);
  assert.match(currentImport, /Failed and superseded runs remain audit records/);
  assert.match(currentImport, /Import corrected set as new/);
  assert.match(currentImport, /earlier sealed data and its failed assessment run remain immutable/);
  assert.match(currentImport, /if \(superseding\) onSupersededDataset\(\)/);
  assert.match(phase5, /Final decisions and export unlock in Phase 6/);
  assert.match(phase5Storage, /assessment results are immutable/i);
  assert.match(phase5Storage, /phase5AssessmentSetIsValid/);
  assert.match(currentData, /no candidate will be silently excluded/i);
  assert.match(currentImport, /test or deliberately de-identified data/i);
  assert.match(currentData, /CURRENT_IDENTITIES_STORE/);
  assert.match(currentData, /loadCurrentCasesForAi/);
  assert.match(phase5Api, /store:false|phase4Post/);
  assert.doesNotMatch(`${currentImport}\n${currentData}`, /OPENAI_API_KEY|api\.openai\.com/);
});
