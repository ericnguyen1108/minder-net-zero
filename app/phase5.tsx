"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadCurrentCasesForAi,
  loadCurrentDatasetBinding,
  loadCurrentIdentitiesForReview,
} from "./current-data";
import type {
  SafeCurrentCase,
  StoredCurrentIdentity,
} from "./current-data";
import {
  createPhase4InputFingerprint,
  validateAiAssessmentBatch,
} from "./phase4-logic";
import type { Phase4ApprovedGuide } from "./phase4-logic";
import type { Phase4Session } from "./phase4-storage";
import {
  buildSafeCurrentPayload,
  classifyPhase5Cohort,
  packPhase5AssessmentBatches,
  phase5RecoveryInputsDiffer,
  selectPhase5EvidenceReviewSampleIds,
  toPhase5StoredAssessment,
} from "./phase5-logic";
import {
  PHASE5_BATCH_ALGORITHM,
  PHASE5_PROMPT_VERSION,
  PHASE5_SAFEGUARD_IDS,
  PHASE5_SCHEMA_VERSION,
  claimNextPhase5Batch,
  commitPhase5Batch,
  confirmPhase5Evidence,
  createPhase5Run,
  createPhase5RunId,
  createPhase5SafeguardApproval,
  failPhase5Batch,
  finalizePhase5Run,
  invalidatePhase5Run,
  loadLatestPhase5Run,
  loadPhase5Results,
  pausePhase5Run,
  phase5AssessmentSetIsValid,
  savePhase5SafeguardApproval,
} from "./phase5-storage";
import type {
  Phase5Run,
  Phase5RunContract,
  Phase5SafeguardApproval,
  Phase5SafeguardId,
  Phase5StoredAssessment,
} from "./phase5-storage";
import {
  FINAL_DECISION_VALUES,
  buildResultsCsv,
  clearFinalDecision,
  loadFinalDecisions,
  resultsFileName,
  saveFinalDecision,
  sortResultsForExport,
} from "./phase6-decisions";
import type { FinalDecision, FinalDecisionValue, ResultsExportRow } from "./phase6-decisions";

type FullGuideRule = Phase4ApprovedGuide["rules"][number] & {
  sourceNote: string;
  passingCondition: string;
  evidence: string;
  anchor1: string;
  anchor3: string;
  anchor5: string;
};

export type Phase5FullGuide = Phase4ApprovedGuide & {
  schemaVersion: 1;
  basedOnVersion: number | null;
  status: "approved";
  rules: FullGuideRule[];
  eligibilityConfirmedNone: boolean;
  eliminationConfirmedNone: boolean;
  selection: {
    mode: "top_n" | "minimum_score" | "both";
    shortlistTarget: string;
    minimumScore: string;
  };
  tieBreakPriority: string[];
  clarificationPolicy: "allowed" | "not_allowed";
  missingInformationAcknowledged: true;
  approvedAt: string;
  approvedBy: string;
};

type ConnectionState = "checking" | "connected" | "not_connected" | "unavailable";

const SAFEGUARDS: Array<{
  id: Phase5SafeguardId;
  title: string;
  body: string;
}> = [
  {
    id: "approved-guide-only",
    title: "Only the approved Decision Guide has authority",
    body: "Historical patterns may clarify an existing rule, but cannot add or change one.",
  },
  {
    id: "no-guessing",
    title: "Missing information is never guessed",
    body: "No evidence means no score. The case goes to Human Review.",
  },
  {
    id: "uncertainty-to-people",
    title: "Uncertainty and boundary ties go to people",
    body: "Minder cannot hide unclear cases below a shortlist cutoff.",
  },
  {
    id: "evidence-required",
    title: "Every score needs an exact quotation",
    body: "The app rechecks each quote against the submitted answer before saving it.",
  },
  {
    id: "identity-minimised",
    title: "Identity stays outside the AI assessment",
    body: "Only an opaque case ID and approved answer fields are sent.",
  },
  {
    id: "device-local-test-only",
    title: "This phase is test-data-only",
    body: "Browser storage is not a shared, backed-up or role-controlled candidate database.",
  },
  {
    id: "people-decide",
    title: "People make every final competition decision",
    body: "Phase 5 produces provisional recommendations only; final approval remains locked.",
  },
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, maximum = 500) {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : "";
}

function shortHash(value: string | null | undefined) {
  return value ? `${value.slice(0, 9)}…${value.slice(-7)}` : "Not available";
}

function secureToken(prefix: string) {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure browser identifiers are unavailable.");
  const bytes = new Uint32Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("")}`;
}

function approvedPatternSnapshot(phase4: Phase4Session) {
  return phase4.patterns
    .filter((pattern) => pattern.decision === "approved")
    .map((pattern) => ({
      id: pattern.id,
      targetRuleId: pattern.targetRuleId,
      proposedInterpretation: pattern.proposedInterpretation,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

type Phase5ApiError = Error & { transient?: boolean };

async function phase5Api(payload: unknown) {
  let response: Response;
  try {
    response = await fetch("/api/phase5", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    const networkError: Phase5ApiError = new Error(
      "Could not reach the assessment service. Saved batches are unchanged.",
    );
    networkError.transient = true;
    throw networkError;
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const errorBody = record(record(body)?.error);
    const apiError: Phase5ApiError = new Error(
      stringValue(errorBody?.message) ||
        "Assessment paused safely. Saved batches are unchanged; try again later.",
    );
    // Upstream hiccups (timeouts, rate limits, 5xx) are worth retrying
    // automatically; contract or validation failures are not.
    apiError.transient = response.status === 429 || response.status >= 500;
    throw apiError;
  }
  const source = record(body);
  if (!source) throw new Error("The managed AI service returned an unreadable response.");
  return source;
}

const TRANSIENT_RETRY_LIMIT = 3;
const TRANSIENT_RETRY_DELAYS_MS = [4_000, 10_000, 20_000];

async function phase5ApiWithRetry(
  payload: unknown,
  onRetryNotice: (message: string) => void,
  shouldStop: () => boolean,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await phase5Api(payload);
    } catch (error) {
      const transient = Boolean((error as Phase5ApiError)?.transient);
      if (!transient || attempt >= TRANSIENT_RETRY_LIMIT || shouldStop()) throw error;
      const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 20_000;
      onRetryNotice(
        `Temporary AI service problem. Retrying automatically (attempt ${attempt + 2} of ${TRANSIENT_RETRY_LIMIT + 1})…`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function SafeguardsWorkspace({
  phase4,
  organiserName,
  approval,
  onApproved,
  onContinue,
  onBack,
}: {
  phase4: Phase4Session;
  organiserName: string;
  approval: Phase5SafeguardApproval | null;
  onApproved: (approval: Phase5SafeguardApproval) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [checked, setChecked] = useState<Phase5SafeguardId[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const allChecked = PHASE5_SAFEGUARD_IDS.every((id) => checked.includes(id));
  const approvedPatterns = phase4.patterns.filter((pattern) => pattern.decision === "approved").length;

  async function lockSafeguards() {
    if (!allChecked || saving || approval) return;
    if (!window.confirm("Lock these safeguards to the passed practice test? They cannot be weakened for this pilot.")) return;
    setSaving(true);
    setError("");
    try {
      const next = await createPhase5SafeguardApproval({
        phase4,
        approvedBy: organiserName,
        acknowledgements: checked,
      });
      await savePhase5SafeguardApproval(next);
      onApproved(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The safeguards were not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="phase5-page">
      <header className="phase5-header">
        <button className="back-button" type="button" onClick={onBack}>← Setup journey</button>
        <div><span className="section-kicker">Step 06 · Safeguards</span><h2>Lock the rules Minder cannot break</h2><p>Think of this as fitting guardrails before the road opens. They are tied to the exact guide, test result and AI model you approved.</p></div>
        <span className={`phase4-status-badge ${approval ? "safe" : "warning"}`}>{approval ? "Locked" : "Needs approval"}</span>
      </header>
      <section className="phase5-critical-warning"><strong>Passing a practice test does not make AI infallible.</strong><p>These safeguards reduce predictable failure modes. They do not replace qualified human review or secure production operations.</p></section>
      {error ? <div className="phase4-error" role="alert"><strong>Stopped safely</strong><span>{error}</span></div> : null}
      <div className="phase5-layout">
        <main className="phase5-main">
          <section className="phase5-card">
            <div className="phase4-card-heading"><div><span className="section-kicker">Always on</span><h3>Seven non-negotiable protections</h3></div><span className="phase4-counter">{approval ? 7 : checked.length}/7 confirmed</span></div>
            <div className="phase5-safeguards">
              {SAFEGUARDS.map((item) => {
                const isChecked = approval ? true : checked.includes(item.id);
                return <label className={`phase5-safeguard ${isChecked ? "confirmed" : ""}`} key={item.id}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={Boolean(approval) || saving}
                    onChange={(event) => setChecked((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))}
                  />
                  <span><strong>{item.title}</strong><small>{item.body}</small></span>
                </label>;
              })}
            </div>
            {approval ? <div className="phase4-approved-box"><strong>Safeguards are frozen</strong><span>Approved by {approval.approvedBy} · receipt {shortHash(approval.approvalHash)}</span></div> : <div className="phase5-lock-action"><p>All seven must be confirmed together. There is no “skip” or “automatic decisions” setting.</p><button className="primary-button" type="button" disabled={!allChecked || saving} onClick={() => void lockSafeguards()}>{saving ? "Locking…" : "Lock safeguards"}</button></div>}
            {approval ? <div className="phase4-final-actions"><button className="primary-button" type="button" onClick={onContinue}>Continue to current applications <span aria-hidden="true">→</span></button></div> : null}
          </section>
        </main>
        <aside className="phase5-rail">
          <section className="rail-card"><div className="rail-label">Frozen contract</div><dl className="phase5-contract-list"><div><dt>Decision Guide</dt><dd>Version {phase4.guideVersion}</dd></div><div><dt>Practice test</dt><dd>Passed</dd></div><div><dt>Optional patterns</dt><dd>{approvedPatterns}</dd></div><div><dt>AI model</dt><dd>{phase4.modelId}</dd></div><div><dt>Metrics receipt</dt><dd>{shortHash(phase4.metricsHash)}</dd></div></dl></section>
          <section className="rail-card history-privacy-card"><div className="rail-label">Production boundary</div><h3>Real candidate data is still off</h3><p>Phase 6 must add managed storage, roles, backups and a shared audit trail before this becomes a live competition system.</p></section>
        </aside>
      </div>
    </div>
  );
}

export function AssessmentWorkspace({
  datasetId,
  guide,
  phase4,
  safeguards,
  organiserName,
  competitionName,
  onRunChange,
  onBack,
  onRecalibrate,
}: {
  datasetId: string;
  guide: Phase5FullGuide;
  phase4: Phase4Session;
  safeguards: Phase5SafeguardApproval;
  organiserName: string;
  competitionName: string;
  onRunChange: (run: Phase5Run | null) => void;
  onBack: () => void;
  onRecalibrate: () => void;
}) {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [cases, setCases] = useState<SafeCurrentCase[]>([]);
  const [identities, setIdentities] = useState<StoredCurrentIdentity[]>([]);
  const [assessments, setAssessments] = useState<Phase5StoredAssessment[]>([]);
  const [run, setRun] = useState<Phase5Run | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryNotice, setRetryNotice] = useState("");
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [preservedInvalidReceipt, setPreservedInvalidReceipt] = useState("");
  const [decisions, setDecisions] = useState<FinalDecision[]>([]);
  const pauseRequested = useRef(false);

  const identityById = useMemo(
    () => new Map(identities.map((identity) => [identity.rowId, identity])),
    [identities],
  );
  const caseById = useMemo(
    () => new Map(cases.map((currentCase) => [currentCase.rowId, currentCase])),
    [cases],
  );
  const assessmentById = useMemo(
    () => new Map(assessments.map((assessment) => [assessment.rowId, assessment])),
    [assessments],
  );
  const currentAssessmentProtocolHash = stringValue(
    phase4.assessmentProtocolHash ?? record(safeguards)?.assessmentProtocolHash,
    300,
  );
  const recoveryInputsChanged = Boolean(
    run?.status === "invalid" &&
      phase5RecoveryInputsDiffer(run.contract, {
        phase4SessionId: phase4.id,
        phase4MetricsHash: phase4.metricsHash ?? "",
        guideContentHash: phase4.guideContentHash,
        approvedPatternsHash: safeguards.approvedPatternsHash,
        expectedModelId: safeguards.expectedModelId,
        promptVersion: PHASE5_PROMPT_VERSION,
        outputSchemaVersion: PHASE5_SCHEMA_VERSION,
        batchAlgorithm: PHASE5_BATCH_ALGORITHM,
        assessmentProtocolHash: currentAssessmentProtocolHash,
      }),
  );

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadCurrentCasesForAi(datasetId),
      loadCurrentIdentitiesForReview(datasetId),
      loadCurrentDatasetBinding(datasetId),
      loadLatestPhase5Run(datasetId),
    ])
      .then(async ([loadedCases, loadedIdentities, binding, loadedRun]) => {
        if (!active) return;
        setCases(loadedCases);
        setIdentities(loadedIdentities);
        if (loadedRun) {
          const contractMatches =
            loadedRun.contract.datasetFingerprint === binding.datasetFingerprint &&
            loadedRun.contract.datasetIntegrityHash === binding.integrityHash &&
            loadedRun.contract.datasetRowCount === binding.totalRows &&
            loadedRun.contract.phase4SessionId === phase4.id &&
            loadedRun.contract.phase4MetricsHash === phase4.metricsHash &&
            loadedRun.contract.assessmentProtocolHash === phase4.assessmentProtocolHash &&
            loadedRun.contract.guideContentHash === phase4.guideContentHash &&
            loadedRun.contract.approvedPatternsHash === safeguards.approvedPatternsHash &&
            loadedRun.contract.expectedModelId === safeguards.expectedModelId &&
            loadedRun.contract.contractHash;
          if (!contractMatches && loadedRun.status !== "invalid") {
            throw new Error("The saved assessment belongs to different locked inputs and cannot be mixed with this run.");
          }
          const loadedAssessments = await loadPhase5Results(loadedRun.id);
          if (!(await phase5AssessmentSetIsValid(loadedRun, loadedAssessments))) {
            throw new Error("The saved assessment results did not pass their integrity check.");
          }
          setRun(loadedRun);
          onRunChange(loadedRun);
          setAssessments(loadedAssessments);
          setDecisions(await loadFinalDecisions(loadedRun.id));
        }
        setInitializing(false);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "The frozen applications could not be verified.");
        setInitializing(false);
      });
    return () => { active = false; };
  }, [datasetId, onRunChange, phase4.assessmentProtocolHash, phase4.guideContentHash, phase4.id, phase4.metricsHash, safeguards.approvedPatternsHash, safeguards.expectedModelId]);

  useEffect(() => {
    let active = true;
    void fetch("/api/phase5", { cache: "no-store" })
      .then(async (response) => {
        const body = record(await response.json().catch(() => null));
        const ai = record(body?.ai);
        const assessmentProtocolHash = stringValue(body?.assessmentProtocolHash, 64);
        if (!active) return;
        setConnection(
          response.ok &&
            ai?.configured === true &&
            assessmentProtocolHash === safeguards.assessmentProtocolHash
            ? "connected"
            : "not_connected",
        );
      })
      .catch(() => { if (active) setConnection("unavailable"); });
    return () => { active = false; };
  }, [safeguards.assessmentProtocolHash]);

  async function buildRun() {
    const binding = await loadCurrentDatasetBinding(datasetId);
    const currentGuideHash = await createPhase4InputFingerprint(guide);
    if (currentGuideHash !== phase4.guideContentHash || currentGuideHash !== safeguards.guideContentHash) {
      throw new Error("The Decision Guide changed after the passed practice test. Start again from calibration.");
    }
    const patterns = approvedPatternSnapshot(phase4);
    const patternsHash = await createPhase4InputFingerprint(patterns);
    if (patternsHash !== safeguards.approvedPatternsHash) {
      throw new Error("Approved teaching guidance changed after safeguards were locked.");
    }
    if (!phase4.metricsHash || !phase4.modelId || !phase4.assessmentProtocolHash) {
      throw new Error("The passed practice-test receipt is incomplete.");
    }
    if (phase4.assessmentProtocolHash !== safeguards.assessmentProtocolHash) {
      throw new Error("The locked assessment protocol changed after safeguards were approved.");
    }
    const runId = createPhase5RunId(datasetId);
    const selection = {
      mode: guide.selection.mode,
      shortlistTarget: guide.selection.shortlistTarget,
      minimumScore: guide.selection.minimumScore,
      tieBreakPriority: [...guide.tieBreakPriority],
    };
    const core: Omit<Phase5RunContract, "contractHash"> = {
      runId,
      datasetFingerprint: binding.datasetFingerprint,
      datasetIntegrityHash: binding.integrityHash,
      datasetRowCount: binding.totalRows,
      phase4SessionId: phase4.id,
      phase4MetricsHash: phase4.metricsHash,
      assessmentProtocolHash: safeguards.assessmentProtocolHash,
      expectedModelId: safeguards.expectedModelId,
      promptVersion: PHASE5_PROMPT_VERSION,
      outputSchemaVersion: PHASE5_SCHEMA_VERSION,
      batchAlgorithm: PHASE5_BATCH_ALGORITHM,
      approvedBy: safeguards.approvedBy,
      approvedAt: safeguards.approvedAt,
      guideContentHash: currentGuideHash,
      approvedPatternsHash: patternsHash,
      selection,
    };
    const contract: Phase5RunContract = {
      ...core,
      contractHash: await createPhase4InputFingerprint(core),
    };
    const fixedRequest = {
      action: "assess_current_cases",
      run: { ...contract, contractHash: "f".repeat(64) },
      batch: { batchId: "batch-0000-placeholder", batchInputHash: "f".repeat(64) },
      guide,
      approvedPatterns: patterns,
    };
    const packed = packPhase5AssessmentBatches(cases, fixedRequest);
    const batches = await Promise.all(
      packed.map(async (batch, batchIndex) => {
        const batchInputHash = await createPhase4InputFingerprint(batch);
        return {
          batchId: `batch-${String(batchIndex + 1).padStart(4, "0")}-${batchInputHash.slice(0, 12)}`,
          batchIndex,
          rowIds: batch.map((item) => item.rowId),
          batchInputHash,
        };
      }),
    );
    return createPhase5Run({ datasetId, contract, batches });
  }

  async function prepareCohort(completeRun: Phase5Run) {
    const stored = await loadPhase5Results(completeRun.id);
    const recommendations = classifyPhase5Cohort({
      assessments: stored,
      expectedRowIds: cases.map((currentCase) => currentCase.rowId),
      guide,
    });
    const evidenceSampleIds = selectPhase5EvidenceReviewSampleIds(
      stored,
      completeRun.contract.contractHash,
    );
    const finalised = await finalizePhase5Run({
      runId: completeRun.id,
      expectedRevision: completeRun.revision,
      recommendations,
      evidenceSampleIds,
    });
    setAssessments(stored);
    setRun(finalised);
    onRunChange(finalised);
    return finalised;
  }

  async function startOrResume() {
    if (busy || connection !== "connected" || cases.length === 0 || run?.status === "invalid") return;
    setBusy(true);
    setError("");
    setRetryNotice("");
    pauseRequested.current = false;
    let working = run;
    let claimed: Awaited<ReturnType<typeof claimNextPhase5Batch>> = null;
    try {
      if (!working) {
        working = await buildRun();
        setRun(working);
        onRunChange(working);
      }
      if (working.status === "complete") {
        await prepareCohort(working);
        return;
      }
      const safeCases = buildSafeCurrentPayload(cases);
      const byId = new Map(safeCases.map((currentCase) => [currentCase.rowId, currentCase]));
      const patterns = approvedPatternSnapshot(phase4);
      while (!pauseRequested.current) {
        const leaseToken = secureToken("lease");
        claimed = await claimNextPhase5Batch({
          runId: working.id,
          expectedRevision: working.revision,
          leaseToken,
        });
        if (!claimed) break;
        working = claimed.run;
        setRun(working);
        onRunChange(working);
        const batchCases = claimed.batch.rowIds.map((rowId) => byId.get(rowId)).filter((item): item is SafeCurrentCase => Boolean(item));
        if (batchCases.length !== claimed.batch.rowIds.length) {
          throw new Error("A fixed batch refers to an application that is no longer available.");
        }
        const body = await phase5ApiWithRetry(
          {
            action: "assess_current_cases",
            run: working.contract,
            batch: {
              batchId: claimed.batch.batchId,
              batchInputHash: claimed.batch.batchInputHash,
            },
            guide,
            approvedPatterns: patterns,
            cases: batchCases,
          },
          setRetryNotice,
          () => pauseRequested.current,
        );
        setRetryNotice("");
        if (
          body.runId !== working.id ||
          body.contractHash !== working.contract.contractHash ||
          body.batchId !== claimed.batch.batchId ||
          body.batchInputHash !== claimed.batch.batchInputHash ||
          body.model !== working.contract.expectedModelId ||
          body.assessmentProtocolHash !== working.contract.assessmentProtocolHash ||
          body.promptVersion !== PHASE5_PROMPT_VERSION ||
          body.outputSchemaVersion !== PHASE5_SCHEMA_VERSION ||
          !Array.isArray(body.findings)
        ) {
          throw new Error("The AI response does not match the fixed assessment contract.");
        }
        const validation = validateAiAssessmentBatch(
          { assessments: body.findings },
          batchCases,
          guide,
        );
        const stored = batchCases.map((currentCase) =>
          toPhase5StoredAssessment(
            working!.id,
            currentCase.rowId,
            validation.results[currentCase.rowId],
          ),
        );
        working = await commitPhase5Batch({
          runId: working.id,
          expectedRevision: working.revision,
          batchId: claimed.batch.batchId,
          leaseToken,
          assessments: stored,
        });
        claimed = null;
        setRun(working);
        onRunChange(working);
        setAssessments(await loadPhase5Results(working.id));
        if (working.status === "complete") break;
      }
      if (working.status === "complete") {
        await prepareCohort(working);
      } else if (pauseRequested.current && working.status === "running") {
        working = await pausePhase5Run(working.id, working.revision);
        setRun(working);
        onRunChange(working);
      }
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : "Assessment paused safely.";
      if (claimed && working) {
        try {
          working = await failPhase5Batch({
            runId: working.id,
            expectedRevision: working.revision,
            batchId: claimed.batch.batchId,
            leaseToken: claimed.batch.leaseToken as string,
            message,
          });
          setRun(working);
          onRunChange(working);
        } catch {
          // The original error is more useful. A stale tab is detected on reload.
        }
      }
      setRetryNotice("");
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEvidence(rowId: string) {
    if (!run || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await confirmPhase5Evidence({
        runId: run.id,
        expectedRevision: run.revision,
        rowId,
      });
      setRun(updated);
      onRunChange(updated);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "The evidence check was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function rejectEvidence(rowId: string) {
    if (!run || busy) return;
    if (!window.confirm("Stop this run because the sampled quotation does not support its finding?")) return;
    setBusy(true);
    setError("");
    try {
      const updated = await invalidatePhase5Run({
        runId: run.id,
        expectedRevision: run.revision,
        reason: `Human relevance check failed for ${rowId}.`,
      });
      setRun(updated);
      onRunChange(updated);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "The failed evidence check was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function createFreshRunAfterRecalibration() {
    if (
      !run ||
      run.status !== "invalid" ||
      !recoveryInputsChanged ||
      !recoveryConfirmed ||
      initializing ||
      busy ||
      cases.length === 0
    ) {
      return;
    }
    if (
      !window.confirm(
        "Create a fresh supervised run using the newly approved calibration? The failed run and its evidence-audit receipt will remain in the audit history.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    const invalidReceipt = run.contract.contractHash;
    try {
      const fresh = await buildRun();
      setAssessments([]);
      setRun(fresh);
      onRunChange(fresh);
      setRecoveryConfirmed(false);
      setPreservedInvalidReceipt(invalidReceipt);
    } catch (recoveryError) {
      setError(
        recoveryError instanceof Error
          ? recoveryError.message
          : "The fresh assessment run was not created. The failed run remains unchanged.",
      );
    } finally {
      setBusy(false);
    }
  }

  const progress = run ? Math.round((run.processedCases / run.caseCount) * 100) : 0;
  const recommendationCounts = useMemo(() => {
    const counts = { progressed: 0, not_progressed: 0, ineligible: 0, human_review: 0 };
    run?.cohortRecommendations.forEach((item) => { counts[item.recommendation] += 1; });
    return counts;
  }, [run?.cohortRecommendations]);
  const decisionByRowId = useMemo(
    () => new Map(decisions.map((decision) => [decision.rowId, decision])),
    [decisions],
  );
  // Decisions are workspace-scoped, so count only those in the current run's
  // cohort — a decision left over from a differently-frozen dataset (or another
  // device) must not inflate the summary. The table and CSV already join by
  // rowId via decisionByRowId, so they are unaffected.
  const cohortDecisions = useMemo(() => {
    if (!run) return [] as FinalDecision[];
    const cohortRowIds = new Set(run.cohortRecommendations.map((item) => item.rowId));
    return decisions.filter((decision) => cohortRowIds.has(decision.rowId));
  }, [run, decisions]);
  const decisionCounts = useMemo(() => {
    const counts = { shortlist: 0, reject: 0, waitlist: 0 };
    cohortDecisions.forEach((decision) => { counts[decision.decision] += 1; });
    return counts;
  }, [cohortDecisions]);
  const orderedResults = useMemo(() => {
    if (!run) return [] as ResultsExportRow[];
    return sortResultsForExport(
      run.cohortRecommendations.map((recommendation) => ({
        recommendation,
        identity: identityById.get(recommendation.rowId) ?? null,
        assessment: assessmentById.get(recommendation.rowId) ?? null,
        decision: decisionByRowId.get(recommendation.rowId) ?? null,
      })),
    );
  }, [run, identityById, assessmentById, decisionByRowId]);

  async function recordDecision(rowId: string, value: FinalDecisionValue | "") {
    if (!run || run.status !== "ready_for_human_review") return;
    setError("");
    try {
      if (value === "") {
        await clearFinalDecision(run.id, rowId);
        setDecisions((current) => current.filter((decision) => decision.rowId !== rowId));
        return;
      }
      const decision: FinalDecision = {
        runId: run.id,
        rowId,
        decision: value,
        decidedBy: organiserName,
        decidedAt: new Date().toISOString(),
      };
      await saveFinalDecision(decision);
      setDecisions((current) => [
        ...current.filter((existing) => existing.rowId !== rowId),
        decision,
      ]);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "The decision was not saved.");
    }
  }

  function exportResultsCsv() {
    if (!run || run.status !== "ready_for_human_review") return;
    const csv = buildResultsCsv(orderedResults);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = resultsFileName(competitionName, new Date().toISOString());
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="phase5-page">
      <header className="phase5-header">
        <button className="back-button" type="button" onClick={onBack}>← Applications</button>
        <div><span className="section-kicker">Step 08 · Supervised assessment</span><h2>Build evidence-backed recommendations</h2><p>Minder processes small fixed batches, saves each one, and can resume after an interruption. Nothing here is a final competition decision.</p></div>
        <span className={`phase4-status-badge ${run?.status === "ready_for_human_review" ? "safe" : run?.status === "invalid" ? "danger" : "warning"}`}>{run?.status.replaceAll("_", " ") ?? "Not started"}</span>
      </header>
      <section className="phase5-critical-warning"><strong>Supervised pilot only.</strong><p>Do not use live candidate data. Exact quotation checks reduce hallucination, but only a person can judge whether a quotation is relevant and whether the recommendation is fair.</p></section>
      {retryNotice && !error ? <div className="phase5-retry-notice" role="status"><strong>Working</strong><span>{retryNotice}</span></div> : null}
      {error ? <div className="phase4-error" role="alert"><strong>Stopped safely</strong><span>{error}</span></div> : null}
      {run?.status === "invalid" ? <div className="phase4-error" role="alert"><strong>Run failed its human evidence audit</strong><span>{run.invalidReason}</span></div> : null}
      <div className="phase5-layout">
        <main className="phase5-main">
          <section className="phase5-card phase5-run-card">
            <div className="phase4-card-heading"><div><span className="section-kicker">Resumable run</span><h3>{initializing ? "Verifying the frozen set…" : run ? `${run.processedCases.toLocaleString()} of ${run.caseCount.toLocaleString()} safely saved` : `${cases.length.toLocaleString()} applications ready`}</h3></div><span className={`phase4-status-badge connection-${connection}`}>{connection === "checking" ? "Checking AI" : connection === "connected" ? "Managed AI connected" : "AI not connected"}</span></div>
            {run ? <div className="phase4-progress"><span style={{ width: `${progress}%` }} /><em>{progress}% safely saved</em></div> : null}
            <div className="phase5-run-facts"><div><span>Fixed applications</span><strong>{cases.length.toLocaleString()}</strong></div><div><span>Batch size</span><strong>Up to 6</strong></div><div><span>Model</span><strong>{safeguards.expectedModelId}</strong></div><div><span>Run receipt</span><strong>{shortHash(run?.contract.contractHash)}</strong></div></div>
            {connection !== "connected" ? <div className="history-alert"><strong>Managed AI is not connected.</strong><p>A Minder administrator must add the server-side OpenAI project secret and pin the exact calibrated model. Never paste an API key into this page.</p></div> : null}
            <div className="phase5-run-actions">
              <button className="primary-button" type="button" disabled={initializing || busy || connection !== "connected" || run?.status === "invalid" || run?.status === "auditing" || run?.status === "ready_for_human_review"} onClick={() => void startOrResume()}>{busy ? "Processing safely…" : !run ? "Start supervised assessment" : run.status === "complete" ? "Prepare cohort recommendations" : "Resume assessment"}</button>
              {busy ? <button className="secondary-button" type="button" onClick={() => { pauseRequested.current = true; }}>Pause after this batch</button> : null}
            </div>
            <p className="phase4-note">A full 700-row run needs at least 117 AI requests and may take meaningful time and cost. Closing the tab pauses future batches; completed batches remain saved on this device.</p>
          </section>

          {preservedInvalidReceipt ? <div className="history-alert" role="status"><strong>Fresh supervised run created</strong><p>The failed run receipt {shortHash(preservedInvalidReceipt)} remains preserved. No application text is sent until you explicitly start the new run.</p></div> : null}

          {run?.status === "invalid" ? <section className="phase5-card phase5-recovery-card">
            <div className="phase4-card-heading"><div><span className="section-kicker">Supervised recovery</span><h3>{recoveryInputsChanged ? "The approved calibration has changed" : "Review and recalibrate before another run"}</h3></div><span className="phase4-status-badge danger">Old run preserved</span></div>
            <p>The failed evidence audit is part of the permanent run history. Minder will not retry the same configuration merely to chase a different AI answer.</p>
            {!recoveryInputsChanged ? <>
              <div className="history-alert history-alert-danger"><strong>A fresh run is still locked.</strong><p>Review the failed application and finding, revise the Decision Guide or teaching guidance if needed, rerun the blind practice test, and approve the safeguards again.</p></div>
              <button className="secondary-button" type="button" onClick={onRecalibrate}>Return to setup and recalibrate</button>
            </> : <>
              <div className="history-alert"><strong>New locked inputs detected.</strong><p>You may reuse this same sealed application set. The invalid run, its results and its audit reason will not be changed or deleted.</p></div>
              <label className="declaration-check">
                <input type="checkbox" checked={recoveryConfirmed} disabled={busy} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />
                <span><strong>I reviewed why the audit failed</strong><small>I confirm the changed calibration and safeguards were approved before creating another supervised run.</small></span>
              </label>
              <button className="primary-button" type="button" disabled={!recoveryConfirmed || busy || initializing} onClick={() => void createFreshRunAfterRecalibration()}>{busy ? "Creating fresh run…" : "Create fresh supervised run"}</button>
            </>}
            <button className="text-button" type="button" onClick={onBack}>Review applications or import corrected source data <span aria-hidden="true">→</span></button>
          </section> : null}

          {run?.status === "auditing" || run?.status === "ready_for_human_review" ? <section className="phase5-card">
            <div className="phase4-card-heading"><div><span className="section-kicker">Human relevance audit</span><h3>Check the fixed evidence sample</h3></div><span className="phase4-counter">{run.reviewedEvidenceIds.length}/{run.evidenceSampleIds.length} checked</span></div>
            <p>Exact text proves the quotation exists; it does not prove the quotation supports the finding. Check each sample before recommendations can move to full human review.</p>
            <div className="phase5-evidence-list">{run.evidenceSampleIds.map((rowId) => {
              const assessment = assessmentById.get(rowId);
              const currentCase = caseById.get(rowId);
              const identity = identityById.get(rowId);
              const reviewed = run.reviewedEvidenceIds.includes(rowId);
              const findings = assessment ? [
                ...assessment.eligibility.map((item) => ({ ruleId: item.ruleId, result: item.status, evidence: item.evidence })),
                ...assessment.elimination.map((item) => ({ ruleId: item.ruleId, result: item.status, evidence: item.evidence })),
                ...assessment.criteria.map((item) => ({ ruleId: item.criterionId, result: item.score === null ? "No score" : `Score ${item.score}/5`, evidence: item.evidence })),
              ].filter((item) => item.evidence.length) : [];
              return <article className={reviewed ? "reviewed" : ""} key={rowId}>
                <div className="phase4-evidence-case-title"><strong>{identity?.teamName || identity?.externalId || "Application"}</strong><span>{identity?.externalId}</span></div>
                <p className="phase4-note"><strong>Every evidence-bearing finding is shown:</strong> {findings.length} findings · {findings.reduce((total, finding) => total + finding.evidence.length, 0)} quotations. Check all of them before confirming this application.</p>
                {findings.map((finding, index) => {
                  const rule = guide.rules.find((item) => item.id === finding.ruleId);
                  return <div className="phase4-evidence-finding" key={`${finding.ruleId}-${index}`}>
                    <p><strong>{rule?.title ?? finding.ruleId}</strong> · {finding.result}</p>
                    {finding.evidence.map((evidence, evidenceIndex) => {
                      const answer = currentCase?.answers[evidence.answerIndex];
                      return <div className="phase5-evidence-quote" key={`${finding.ruleId}-${index}-${evidenceIndex}`}><blockquote>“{evidence.quote}”<small>{answer?.heading ?? "Application answer"}</small></blockquote><details><summary>View the full source answer</summary><small>{answer?.value ?? "Source answer unavailable"}</small></details></div>;
                    })}
                  </div>;
                })}
                {!reviewed && run.status === "auditing" ? <div className="phase5-evidence-actions"><button className="secondary-button" type="button" disabled={busy || findings.length === 0} onClick={() => void confirmEvidence(rowId)}>All shown evidence supports every finding</button><button className="danger-button" type="button" disabled={busy} onClick={() => void rejectEvidence(rowId)}>Any finding is not supported</button></div> : <div className="phase4-approved-box"><strong>Human relevance checked</strong></div>}
              </article>;
            })}</div>
          </section> : null}

          {run?.status === "ready_for_human_review" ? <section className="phase5-card phase5-queue-card">
            <div><span className="section-kicker">Final human review</span><h3>Record the final decision for every application</h3><p>Minder&apos;s recommendations are provisional. An authorised person records each final decision; nothing is decided until you decide it. Human Review cases have no rank on purpose — read them first.</p></div>
            <div className="phase5-recommendation-grid"><div><span>Provisional shortlist zone</span><strong>{recommendationCounts.progressed}</strong></div><div><span>Outside provisional zone</span><strong>{recommendationCounts.not_progressed}</strong></div><div><span>Potentially ineligible</span><strong>{recommendationCounts.ineligible}</strong></div><div className="attention"><span>Human Review first</span><strong>{recommendationCounts.human_review}</strong></div></div>
            <div className="phase5-decision-summary" role="status">
              <strong>{cohortDecisions.length.toLocaleString()} of {run.cohortRecommendations.length.toLocaleString()} decided</strong>
              <span>{decisionCounts.shortlist} shortlisted · {decisionCounts.waitlist} waitlisted · {decisionCounts.reject} rejected</span>
              <button className="secondary-button" type="button" onClick={exportResultsCsv}>Export results (CSV)</button>
            </div>
            <div className="phase5-results-table-wrap">
              <table className="phase5-results-table">
                <thead><tr><th>Rank</th><th>Team</th><th>ID · Track</th><th>Score</th><th>Minder recommends</th><th>Why</th><th>Final decision</th></tr></thead>
                <tbody>{orderedResults.map((row) => {
                  const identity = row.identity;
                  const decision = row.decision;
                  const needsHuman = row.recommendation.recommendation === "human_review";
                  return <tr className={needsHuman ? "phase5-row-review" : ""} key={row.recommendation.rowId}>
                    <td>{row.recommendation.rank ?? "—"}</td>
                    <td><strong>{identity?.teamName || identity?.externalId || "Application"}</strong></td>
                    <td><small>{identity?.externalId}{identity?.track ? ` · ${identity.track}` : ""}</small></td>
                    <td>{row.recommendation.weightedScore ?? "—"}</td>
                    <td><span className={`phase5-reco phase5-reco-${row.recommendation.recommendation}`}>{row.recommendation.recommendation.replaceAll("_", " ")}</span></td>
                    <td><small>{row.recommendation.reason.replaceAll("_", " ")}{row.assessment?.humanReviewReasons.length ? ` — ${row.assessment.humanReviewReasons[0]}` : ""}</small></td>
                    <td>
                      <select
                        aria-label={`Final decision for ${identity?.teamName || row.recommendation.rowId}`}
                        value={decision?.decision ?? ""}
                        onChange={(event) => void recordDecision(row.recommendation.rowId, event.target.value as FinalDecisionValue | "")}
                      >
                        <option value="">Undecided</option>
                        {FINAL_DECISION_VALUES.map((value) => <option key={value} value={value}>{value === "shortlist" ? "Shortlist" : value === "reject" ? "Reject" : "Waitlist"}</option>)}
                      </select>
                      {decision ? <small className="phase5-decided-by">{decision.decidedBy}</small> : null}
                    </td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <p className="phase4-note">The CSV export includes every application with Minder&apos;s recommendation, its reason, and the recorded human decision — undecided rows export with an empty decision. Applicant-authored text is exported as text, never as spreadsheet formulas.</p>
          </section> : null}
        </main>
        <aside className="phase5-rail">
          <section className="rail-card"><div className="rail-label">Run contract</div><dl className="phase5-contract-list"><div><dt>Guide</dt><dd>Version {guide.version}</dd></div><div><dt>Applications</dt><dd>{cases.length.toLocaleString()}</dd></div><div><dt>Prompt</dt><dd>{PHASE5_PROMPT_VERSION}</dd></div><div><dt>Output schema</dt><dd>{PHASE5_SCHEMA_VERSION}</dd></div><div><dt>Dataset</dt><dd>{shortHash(run?.contract.datasetFingerprint)}</dd></div></dl></section>
          <section className="rail-card"><div className="rail-label">Sent to AI</div><ul className="phase4-rail-list"><li>Opaque case ID</li><li>Approved answer headings</li><li>Submitted answer text</li><li>Approved rules and patterns</li></ul></section>
          <section className="rail-card history-privacy-card"><div className="rail-label">Never sent as separate fields</div><ul className="phase4-rail-list"><li>Application ID</li><li>Team name or track</li><li>Old outcome or judge score</li><li>Reviewer notes</li><li>Final decision</li></ul><p>Personal information embedded inside an answer can still be present.</p></section>
        </aside>
      </div>
    </div>
  );
}
