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
import { createCurrentDataset } from "../../current-data.ts";
import { createPhase4InputFingerprint } from "../../phase4-logic.ts";
import { optionalDatabaseUuid } from "./input.ts";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CONFLICT_ERRORS = new Set(["revision_conflict", "already_revealed", "stale_lease", "unknown_batch"]);
const DATABASE_CONNECTION_ERRORS = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "PILOT_DATABASE_NOT_CONFIGURED",
]);

/** PostgreSQL and its driver attach structured fields that domain errors do not. */
export function isDatabaseShapedError(error: unknown): boolean {
  if (!isObject(error)) return false;
  const name = typeof error.name === "string" ? error.name : "";
  const code = typeof error.code === "string" ? error.code.toUpperCase() : "";
  if (name === "PostgresError" || /^[0-9A-Z]{5}$/.test(code)) return true;
  if (DATABASE_CONNECTION_ERRORS.has(code) || code.startsWith("CONNECTION_")) return true;
  return ["severity", "routine", "schema_name", "table_name", "constraint_name"].some(
    (field) => typeof error[field] === "string",
  );
}

export function pilotActionErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "The action failed.";
  if (CONFLICT_ERRORS.has(message)) return json({ error: { code: message } }, 409);
  if (isDatabaseShapedError(error)) {
    return json(
      {
        error: {
          code: "pilot_store_unavailable",
          message: "The workspace data store is temporarily unavailable. Keep this tab open and try again.",
        },
      },
      503,
    );
  }
  return json({ error: { code: "action_failed", message } }, 400);
}

/** Log only diagnostic classifications, never the database message or request data. */
export function reportPilotActionError(action: string, error: unknown): void {
  if (!isDatabaseShapedError(error)) return;
  const record = isObject(error) ? error : {};
  console.error("pilot_action_database_error", {
    action,
    errorName: typeof record.name === "string" ? record.name : "unknown",
    errorCode: typeof record.code === "string" ? record.code : "unknown",
  });
}

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
    reportPilotActionError(action, error);
    return pilotActionErrorResponse(error);
  }
}

async function dispatch(action: string, p: Record<string, unknown>, wsId: string): Promise<unknown> {
  switch (action) {
    // ---- reviewers ------------------------------------------------------
    case "reviewers.list":
      return marking.listReviewers(wsId);
    case "reviewers.add": {
      if (typeof p.displayName !== "string") throw new Error("Enter the reviewer's name.");
      return marking.addReviewer(wsId, p.displayName);
    }
    case "reviewers.setActive":
      if (typeof p.active !== "boolean") throw new Error("Choose whether the reviewer is active.");
      await marking.setReviewerActive(wsId, String(p.reviewerId), Boolean(p.active));
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
    case "guide.syncApproved": {
      if (!isObject(p.guide) || p.guide.status !== "approved" || !Array.isArray(p.guide.rules)) {
        throw new Error("An approved Decision Guide is required for human marking.");
      }
      const selection = isObject(p.guide.selection) ? p.guide.selection : null;
      const selectionMode = selection?.mode;
      if (!selection || !["top_n", "minimum_score", "both"].includes(String(selectionMode))) {
        throw new Error("The approved Decision Guide has no valid selection rule.");
      }
      const criteria = p.guide.rules
        .filter((rule): rule is Record<string, unknown> => isObject(rule) && rule.kind === "criterion")
        .map((rule, position) => ({
          ruleId: String(rule.id ?? ""),
          title: String(rule.title ?? ""),
          weight: Number(rule.weight),
          position,
        }));
      const contentHash = await createPhase4InputFingerprint(p.guide as never);
      if (contentHash !== p.contentHash) {
        throw new Error("The Decision Guide does not match the passed practice-test receipt.");
      }
      const shortlistTarget =
        selectionMode === "top_n" || selectionMode === "both"
          ? Number(selection.shortlistTarget)
          : null;
      const minimumScore =
        selectionMode === "minimum_score" || selectionMode === "both"
          ? Number(selection.minimumScore)
          : null;
      return marking.syncApprovedGuide(wsId, {
        version: Number(p.guide.version),
        rules: p.guide,
        selectionMode: selectionMode as marking.ApprovedGuide["selectionMode"],
        shortlistTarget,
        minimumScore,
        contentHash,
        criteria,
        approvedByName: String(p.guide.approvedBy ?? ""),
      });
    }

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
      return importRepo.saveHistoricalDataset(
        wsId,
        sealed,
        optionalDatabaseUuid(p.replaceDatasetId),
      );
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
    case "current.import": {
      const sealed = await createCurrentDataset({
        datasetId: crypto.randomUUID(),
        fileName: String(p.fileName ?? "current-applications.csv"),
        fileSize: Number(p.fileSize ?? 0),
        table: p.table as never,
        mapping: p.mapping as never,
      });
      return importRepo.saveCurrentDataset(
        wsId,
        sealed,
        optionalDatabaseUuid(p.replaceDatasetId),
      );
    }
    case "current.aiCases":
      return importRepo.loadCurrentCasesForAiInWorkspace(wsId, String(p.datasetId));
    case "current.identities":
      return importRepo.loadCurrentIdentitiesForReview(wsId, String(p.datasetId));
    case "current.active":
      return importRepo.loadActiveCurrentSummary(wsId);
    case "current.binding":
      return importRepo.loadCurrentDatasetBinding(wsId, String(p.datasetId));
    case "current.exists":
      return { exists: await importRepo.currentDatasetExists(wsId, String(p.datasetId)) };
    case "current.delete":
      await importRepo.deleteCurrentDataset(wsId, String(p.datasetId));
      return { ok: true };

    // ---- calibration ----------------------------------------------------
    case "calibration.load":
      return cal.loadSessionDocument(wsId, String(p.datasetId), Number(p.guideVersion ?? 1));
    case "calibration.save":
      if (!isObject(p.session)) throw new Error("A Phase 4 session is required.");
      return cal.saveSessionDocument({
        workspaceId: wsId,
        session: p.session as never,
        resetWithCredit: Boolean(p.resetWithCredit),
      });
    case "calibration.reveal":
      return cal.revealSession({
        workspaceId: wsId,
        datasetId: String(p.datasetId),
        guideVersion: Number(p.guideVersion ?? 1),
        expectedRevision: Number(p.expectedRevision),
      });
    case "calibration.credit": {
      const granted = await cal.grantRecalibrationCreditForSession(
        wsId,
        String(p.sessionId),
        String(p.reason ?? "phase5_audit_failure"),
      );
      return { granted };
    }
    case "calibration.consumed":
      return cal.consumedState(wsId, String(p.datasetFingerprint));

    // ---- AI assessment (reference only) --------------------------------
    case "assessment.safeguards.save":
      return asm.saveSafeguardApproval(wsId, p.approval as never);
    case "assessment.safeguards.load":
      return asm.loadSafeguardApproval(wsId, String(p.phase4SessionId));
    case "assessment.document.create":
      return asm.createPhase5RunDocument({
        workspaceId: wsId,
        run: p.run as never,
        batches: (p.batches as never[]) ?? [],
      });
    case "assessment.document.load":
      return asm.loadPhase5RunDocument(wsId, String(p.runId));
    case "assessment.document.latest":
      return asm.loadLatestPhase5RunDocument(wsId, String(p.datasetId));
    case "assessment.document.batches":
      return asm.loadPhase5Batches(wsId, String(p.runId));
    case "assessment.document.results":
      return asm.loadPhase5AssessmentResults(wsId, String(p.runId));
    case "assessment.document.claim":
      return asm.claimNextPhase5Batch({
        workspaceId: wsId,
        runId: String(p.runId),
        expectedRevision: Number(p.expectedRevision),
        leaseToken: String(p.leaseToken),
        leaseMilliseconds:
          p.leaseMilliseconds === undefined ? undefined : Number(p.leaseMilliseconds),
      });
    case "assessment.document.commit":
      return asm.commitPhase5Batch({
        workspaceId: wsId,
        runId: String(p.runId),
        expectedRevision: Number(p.expectedRevision),
        batchId: String(p.batchId),
        leaseToken: String(p.leaseToken),
        assessments: (p.assessments as never[]) ?? [],
      });
    case "assessment.document.fail":
      return asm.failPhase5BatchDocument({
        workspaceId: wsId,
        runId: String(p.runId),
        expectedRevision: Number(p.expectedRevision),
        batchId: String(p.batchId),
        leaseToken: String(p.leaseToken),
        message: String(p.message ?? ""),
      });
    case "assessment.document.pause":
      return asm.pausePhase5RunDocument({
        workspaceId: wsId,
        runId: String(p.runId),
        expectedRevision: Number(p.expectedRevision),
      });
    case "assessment.document.finalize":
      return asm.finalizePhase5RunDocument({
        workspaceId: wsId,
        runId: String(p.runId),
        expectedRevision: Number(p.expectedRevision),
        recommendations: (p.recommendations as never[]) ?? [],
        evidenceSampleIds: (p.evidenceSampleIds as string[]) ?? [],
      });
    case "assessment.document.confirmEvidence":
      return asm.confirmPhase5EvidenceDocument({
        workspaceId: wsId,
        runId: String(p.runId),
        expectedRevision: Number(p.expectedRevision),
        rowId: String(p.rowId),
      });
    case "assessment.document.invalidate": {
      const invalidated = await asm.invalidatePhase5RunDocument({
        workspaceId: wsId,
        runId: String(p.runId),
        expectedRevision: Number(p.expectedRevision),
        reason: String(p.reason ?? ""),
      });
      try {
        await cal.grantRecalibrationCreditForSession(
          wsId,
          invalidated.contract.phase4SessionId,
          "phase5_audit_failure",
        );
      } catch {
        // The invalidation is already durable; support can grant the credit later.
      }
      return invalidated;
    }
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
      return marking.submitMarkSet(
        wsId,
        String(p.applicationRowId),
        String(p.reviewerId),
        String(p.guideVersionId),
      );
    case "marks.load":
      return marking.loadMarkSets(wsId);
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
