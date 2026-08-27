import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { createSessionToken, SESSION_COOKIE_NAME } from "../app/auth.ts";

const root = new URL("../", import.meta.url);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Boots the production build (`next start`) and fetches the rendered page. */
async function renderProductionHomepage() {
  const port = await freePort();
  const sessionSecret = "rendered-homepage-test-secret";
  const sessionToken = await createSessionToken(sessionSecret, Date.now() + 60_000);
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--port", String(port)],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        AUTH_MODE: "legacy",
        ALLOW_LEGACY_PRODUCTION: "true",
        ORGANISER_ACCESS_CODE: "rendered-homepage-test-code",
        SESSION_SECRET: sessionSecret,
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    const deadline = Date.now() + 30_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          headers: {
            accept: "text/html",
            cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          },
        });
        return { response, html: await response.text() };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`next start did not become ready: ${lastError}\n${output}`);
  } finally {
    child.kill("SIGTERM");
  }
}

test("server-renders the Minder Net Zero setup experience", async () => {
  const { response, html } = await renderProductionHomepage();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

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
  assert.match(historyImport, /Historical data is not sent to AI in this step/);
  assert.match(historyImport, /Saved in the private pilot workspace/);
  assert.match(historyData, /"historical\.import"/);
  assert.match(historyData, /"historical\.teaching"/);
  assert.match(historyData, /"historical\.blind"/);
  assert.match(historyData, /"historical\.active"/);
  assert.match(historyData, /did not pass its integrity check/);
  assert.doesNotMatch(historyData, /indexedDB|IDBDatabase|openDatabase/);
  assert.doesNotMatch(`${historyImport}\n${historyData}\n${historyParser}`, /fetch\(|OPENAI_API_KEY|api\.openai\.com/);
  assert.match(layout, /fair, evidence-backed application review/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|site-creator-vinext-starter|vinext|wrangler|cloudflare/);

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../worker/index.ts", import.meta.url)));
  await assert.rejects(access(new URL("../.openai/hosting.json", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(root);
});

test("renders the account dialog above the sticky application layout", async () => {
  const [accountControls, styles] = await Promise.all([
    readFile(new URL("../app/account-controls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(accountControls, /import \{ createPortal \} from "react-dom"/);
  assert.match(accountControls, /createPortal\([\s\S]*account-modal-backdrop[\s\S]*document\.body\)/);
  assert.match(styles, /\.sidebar\s*\{[\s\S]*position:\s*sticky/);
  assert.match(styles, /\.account-modal-backdrop\s*\{[\s\S]*z-index:\s*1000/);
  assert.match(styles, /\.approval-checkbox\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.approval-checkbox > span\s*\{[\s\S]*display:\s*grid/);
});

test("implements Phase 5 assessment, Phase F human marking, and final decisions", async () => {
  const [page, phase4, storage, phase5, phase5Storage, currentImport, currentData, phase5Api, decisions, marking, markingUi] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase4-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/phase5.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/phase5-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/current-import.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/current-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/phase5/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/phase6-decisions.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/pilot-marking.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/pilot-marking-workspace.tsx", import.meta.url), "utf8"),
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
  assert.match(page, /historicalImport\.guideVersion === guide\.version/);
  assert.match(phase4, /AI service not connected/);
  assert.match(phase4, /Historical agreement is not truth/);
  assert.match(phase4, /Approve for supervised pilot/);
  assert.match(phase4, /Human relevance check/);
  assert.match(phase4, /validateAiAssessmentBatch/);
  assert.match(storage, /predictions_committed/);
  assert.match(storage, /"calibration\.reveal"/);
  assert.match(storage, /"calibration\.consumed"/);
  assert.match(storage, /one-use receipt/);
  assert.doesNotMatch(storage, /PHASE4_CONSUMED_STORE|SEALED_STORE/);
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
  assert.match(phase5, /Record the final decision for every application/);
  assert.match(phase5, /Export results \(CSV\)/);
  assert.match(phase5, /nothing is decided until you decide it/i);
  assert.match(phase5, /Final decisions are locked/);
  assert.match(phase5, /AI reference · not counted/);
  assert.match(phase5, /disabled={!humanRankingReady \|\| !decisionMaker}/);
  assert.match(decisions, /formula-injection guard/i);
  assert.match(decisions, /decidedBy/);
  assert.match(decisions, /human_total_score/);
  assert.match(marking, /humanRankingIsReady/);
  assert.match(marking, /"marks\.upsert"/);
  assert.match(marking, /"marks\.submit"/);
  assert.match(markingUi, /Human marking · authoritative ranking/);
  assert.match(markingUi, /AI cannot enter this ranking/);
  assert.match(markingUi, /Add required reviewer/);
  assert.match(markingUi, /Submit and freeze review/);
  assert.match(phase5Storage, /assessment results are immutable/i);
  assert.match(phase5Storage, /phase5AssessmentSetIsValid/);
  assert.match(currentData, /no candidate will be silently excluded/i);
  assert.match(currentImport, /test or deliberately de-identified data/i);
  assert.doesNotMatch(currentData, /indexedDB|IDBDatabase|CURRENT_IDENTITIES_STORE/);
  assert.match(currentData, /loadCurrentCasesForAi/);
  assert.match(phase5Api, /store:false|phase4Post/);
  assert.doesNotMatch(`${currentImport}\n${currentData}`, /OPENAI_API_KEY|api\.openai\.com/);
});
