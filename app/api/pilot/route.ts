/**
 * Pilot API: a single auth-gated dispatch route over the pilot repositories.
 * Follows the app's existing action-dispatch pattern. Every request is
 * authorized by the shared-access-code session cookie and scoped to the one
 * pilot workspace, resolved server-side.
 *
 * The historical-import action runs prepareHistoricalDataset +
 * createSealedHistoricalDataset SERVER-SIDE, so the dataset fingerprint and the
 * teaching/sealed partition are always derived here, never accepted from the
 * client. The current-import fingerprint is likewise computed server-side.
 */

import { requestIsAuthorized } from "../../auth.ts";
import { createSealedHistoricalDataset, prepareHistoricalDataset } from "../../historical-data.ts";
import * as marking from "../../../db/pilot/marking-repository.ts";
import * as importRepo from "../../../db/pilot/import-repository.ts";
import * as cal from "../../../db/pilot/calibration-repository.ts";
import * as asm from "../../../db/pilot/assessment-repository.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const WORKSPACE_NAME = process.env.MINDER_COMPETITION_NAME?.trim() || "Minder Net Zero";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CONFLICT_ERRORS = new Set(["revision_conflict", "already_revealed", "stale_lease", "unknown_batch"]);

// The client speaks shortlist/reject/waitlist; the DB CHECK speaks the -ed forms
// plus `undecided` (a cleared decision, recorded rather than deleted so the
// append-only final_decision_events journal captures it).
const DECISION_TO_DB = { shortlist: "shortlisted", reject: "rejected", waitlist: "waitlisted" } as const;
const DECISION_FROM_DB = { shortlisted: "shortlist", rejected: "reject", waitlisted: "waitlist" } as const;

/** Resolve an optional typed name to a roster reviewer id (seeding the roster). */
async function resolveDecider(wsId: string, decidedByName: unknown): Promise<string | null> {
  const name = typeof decidedByName === "string" ? decidedByName.trim() : "";
  if (!name) return null;
  const reviewer = await marking.ensureReviewerByName(wsId, name);
  return reviewer.id;
}

export async function POST(request: Request): Promise<Response> {
  const authorized = await requestIsAuthorized({
    hostHeader: request.headers.get("host"),
    cookieHeader: request.headers.get("cookie"),
    nowMs: Date.now(),
  });
  if (!authorized) {
    return json({ error: { code: "authentication_required", message: "Sign in to continue." } }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "bad_request", message: "Invalid JSON." } }, 400);
  }
  if (!isObject(body) || typeof body.action !== "string") {
    return json({ error: { code: "bad_request", message: "Missing action." } }, 400);
  }
  const action = body.action;
  const p = isObject(body.payload) ? body.payload : {};

  try {
    const ws = await marking.ensureWorkspace(WORKSPACE_NAME, 0);
    const wsId = ws.id;
    const data = await dispatch(action, p, wsId);
    if (data === undefined) return json({ error: { code: "unknown_action", message: action } }, 400);
    return json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The action failed.";
    if (CONFLICT_ERRORS.has(message)) return json({ error: { code: message } }, 409);
    return json({ error: { code: "action_failed", message } }, 400);
  }
}

async function dispatch(action: string, p: Record<string, unknown>, wsId: string): Promise<unknown> {
  switch (action) {
    // ---- reviewers ------------------------------------------------------
    case "reviewers.list":
      return marking.listReviewers(wsId);
    case "reviewers.add":
      return marking.addReviewer(wsId, String(p.displayName));
    case "reviewers.setActive":
      await marking.setReviewerActive(String(p.reviewerId), Boolean(p.active));
      return { ok: true };

    // ---- guide ----------------------------------------------------------
    case "guide.load":
      return marking.loadApprovedGuide(wsId);
    case "guide.saveDraft":
      return marking.saveGuideDraft(wsId, {
        rules: p.rules,
        selectionMode: p.selectionMode as "top_n" | "minimum_score" | "both",
        shortlistTarget: (p.shortlistTarget as number | null) ?? null,
        minimumScore: (p.minimumScore as number | null) ?? null,
        contentHash: String(p.contentHash),
        criteria: (p.criteria as marking.GuideCriterion[]) ?? [],
      });
    case "guide.approve":
      await marking.approveGuide(String(p.guideVersionId), String(p.reviewerId));
      return { ok: true };

    // ---- historical (calibration input) --------------------------------
    case "historical.import": {
      const prepared = prepareHistoricalDataset(
        p.table as never,
        p.mapping as never,
        p.outcomeMapping as never,
      );
      const sealed = await createSealedHistoricalDataset({
        datasetId: crypto.randomUUID(),
        fileName: String(p.fileName ?? "history.csv"),
        fileSize: Number(p.fileSize ?? 0),
        table: p.table as never,
        guideVersion: Number(p.guideVersion ?? 1),
        mapping: p.mapping as never,
        outcomeMapping: p.outcomeMapping as never,
        prepared,
      });
      // saveHistoricalDataset returns { datasetId, fingerprint, summary } with
      // the summary's datasetId reconciled to the DB id.
      return importRepo.saveHistoricalDataset(wsId, sealed, (p.replaceDatasetId as string | null) ?? null);
    }
    case "historical.teaching":
      return importRepo.loadTeachingRows(String(p.datasetId));
    case "historical.blind":
      return importRepo.loadBlindCases(String(p.datasetId));
    case "historical.active":
      return importRepo.loadActiveHistoricalSummary(wsId);
    case "historical.binding":
      return importRepo.loadHistoricalDatasetBinding(wsId, String(p.datasetId));
    case "historical.exists":
      return { exists: await importRepo.historicalDatasetExists(wsId, String(p.datasetId)) };
    case "historical.delete":
      await importRepo.deleteHistoricalDataset(wsId, String(p.datasetId));
      return { ok: true };

    // ---- current applications ------------------------------------------
    case "current.freeze": {
      const cases = (p.cases as importRepo.CurrentCaseInput[]) ?? [];
      // Fingerprint derived server-side from the sorted case answers.
      const fingerprintInput = JSON.stringify(
        [...cases]
          .map((c) => ({ rowId: c.rowId, answers: c.answers }))
          .sort((a, b) => a.rowId.localeCompare(b.rowId)),
      );
      const fingerprint = await sha256Hex(fingerprintInput);
      return importRepo.freezeCurrentDataset(wsId, { name: String(p.name ?? "Round"), fingerprint, cases });
    }
    case "current.aiCases":
      return importRepo.loadCurrentCasesForAi(String(p.datasetId));

    // ---- calibration ----------------------------------------------------
    case "calibration.session":
      return cal.getOrCreateSession(wsId, String(p.datasetId), Number(p.guideVersion ?? 1));
    case "calibration.save":
      return cal.saveSession({ id: String(p.id), expectedRevision: Number(p.expectedRevision), ...(p as object) } as never);
    case "calibration.reveal":
      return cal.revealOutcomes({
        workspaceId: wsId,
        datasetId: String(p.datasetId),
        datasetFingerprint: String(p.datasetFingerprint),
        sessionId: String(p.sessionId),
      });
    case "calibration.credit":
      await cal.grantRecalibrationCredit({
        datasetFingerprint: String(p.datasetFingerprint),
        sessionId: String(p.sessionId),
        reason: String(p.reason ?? "phase5_audit_failure"),
      });
      return { ok: true };
    case "calibration.headroom":
      return { headroom: await cal.revealHeadroom(String(p.datasetFingerprint)) };

    // ---- AI assessment (reference only) --------------------------------
    case "assessment.createRun":
      return asm.createRun({
        workspaceId: wsId,
        currentDatasetId: String(p.currentDatasetId),
        guideVersion: Number(p.guideVersion ?? 1),
        modelId: String(p.modelId),
        contractHash: String(p.contractHash),
        protocolHash: String(p.protocolHash),
        batches: (p.batches as { index: number; inputHash: string }[]) ?? [],
      });
    case "assessment.claim":
      return asm.claimBatch(String(p.runId), Number(p.batchIndex));
    case "assessment.commit":
      return asm.commitBatchResults({
        runId: String(p.runId),
        batchId: String(p.batchId),
        leaseToken: String(p.leaseToken),
        results: (p.results as asm.AssessmentResultInput[]) ?? [],
      });
    case "assessment.fail":
      await asm.failBatch({ batchId: String(p.batchId), leaseToken: String(p.leaseToken) });
      return { ok: true };
    case "assessment.results":
      return asm.loadResults(String(p.runId));
    case "assessment.progress":
      return asm.runProgress(String(p.runId));

    // ---- human marking + ranking + decisions ---------------------------
    case "marks.upsert":
      await marking.upsertMark({
        workspaceId: wsId,
        applicationRowId: String(p.applicationRowId),
        reviewerId: String(p.reviewerId),
        guideVersionId: String(p.guideVersionId),
        ruleId: String(p.ruleId),
        score: Number(p.score),
      });
      return { ok: true };
    case "marks.submit":
      return marking.submitMarkSet(wsId, String(p.applicationRowId), String(p.reviewerId));
    case "ranking.load":
      return marking.loadRanking(wsId);
    case "ai.reference":
      return marking.loadAiReference(wsId);
    case "decisions.record": {
      const dbDecision = DECISION_TO_DB[String(p.decision) as keyof typeof DECISION_TO_DB];
      if (!dbDecision) throw new Error("Only shortlist, reject or waitlist can be recorded.");
      await marking.recordFinalDecision({
        workspaceId: wsId,
        applicationRowId: String(p.applicationRowId),
        decision: dbDecision,
        decidedBy: await resolveDecider(wsId, p.decidedByName),
        notes: (p.notes as string | null) ?? null,
      });
      return { ok: true };
    }
    case "decisions.clear":
      // A cleared decision is recorded as `undecided`, not deleted, so the
      // append-only journal keeps the un-decision; decisions.load hides it.
      await marking.recordFinalDecision({
        workspaceId: wsId,
        applicationRowId: String(p.applicationRowId),
        decision: "undecided",
        decidedBy: await resolveDecider(wsId, p.decidedByName),
        notes: null,
      });
      return { ok: true };
    case "decisions.load":
      return (await marking.loadFinalDecisions(wsId))
        .filter((d) => d.decision !== "undecided")
        .map((d) => ({
          rowId: d.applicationRowId,
          decision: DECISION_FROM_DB[d.decision as keyof typeof DECISION_FROM_DB],
          decidedBy: d.decidedByName ?? "",
          decidedAt: new Date(d.decidedAt).toISOString(),
        }));

    default:
      return undefined;
  }
}
