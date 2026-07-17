"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildBlindSealedPayload,
  buildSafeTeachingPayload,
  calculateLockedPracticeMetrics,
  createPhase4InputFingerprint,
  validateAiAssessmentBatch,
} from "./phase4-logic";
import type {
  Phase4ApprovedGuide,
  Phase4SourceRow,
} from "./phase4-logic";
import { getPhase4AssessmentProtocolHash } from "./phase4-protocol";
import {
  loadBlindPracticeRows,
  loadHistoricalDatasetBinding,
  loadTeachingRows,
} from "./historical-data";
import {
  createPhase4Session,
  loadPhase4RecalibrationCredits,
  loadPhase4Session,
  mergePhase4Patterns,
  phase4SummaryFromSession,
  resetPhase4SessionWithCredit,
  revealCommittedOutcomes,
  savePhase4Session,
  selectEvidenceReviewSampleIds,
} from "./phase4-storage";
import type {
  Phase4Pattern,
  Phase4Session,
  Phase4Summary,
  PracticeAcceptancePolicy,
  StoredBlindAssessment,
} from "./phase4-storage";

type Phase4Step = "teach" | "test";
type ConnectionState = "checking" | "connected" | "not_connected" | "unavailable";
type WorkspaceGuide = Phase4ApprovedGuide & {
  tieBreakPriority: string[];
  clarificationPolicy: "allowed" | "not_allowed" | "";
};

type Phase4WorkspaceProps = {
  datasetId: string;
  guide: WorkspaceGuide;
  organiserName: string;
  initialStep: Phase4Step;
  onSummaryChange: (summary: Phase4Summary) => void;
  onBack: () => void;
};

const TEACHING_BATCH_SIZE = 12;
const PRACTICE_BATCH_SIZE = 6;
const MAX_REVIEW_PATTERNS = 20;

const PATTERN_KINDS = new Set([
  "criterion_anchor_example",
  "eligibility_example",
  "elimination_example",
  "ambiguity",
  "historical_conflict",
  "possible_policy_gap",
]);

const PATTERN_RISKS = new Set([
  "guide_aligned",
  "possible_bias",
  "inconsistent_history",
  "conflicts_with_guide",
]);

const REJECTION_REASONS = [
  "Not in the official rubric",
  "Insufficient evidence",
  "Likely bias",
  "Past decisions are inconsistent",
  "Needs a Decision Guide revision",
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, max = 2_000) {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : "";
}

function percentText(value: number | null) {
  return value === null ? "Not enough data" : `${value.toFixed(value % 1 ? 1 : 0)}%`;
}

function shortFingerprint(value: string) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "Not available";
}

function guideForAi(guide: WorkspaceGuide) {
  return {
    version: guide.version,
    status: guide.status,
    rules: guide.rules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      title: rule.title,
      statement: rule.statement,
      passingCondition: rule.passingCondition ?? "",
      evidence: rule.evidence ?? "",
      weight: rule.weight,
      anchor1: rule.anchor1 ?? "",
      anchor3: rule.anchor3 ?? "",
      anchor5: rule.anchor5 ?? "",
    })),
    selection: {
      mode: guide.selection.mode,
      shortlistTarget: guide.selection.shortlistTarget ?? "",
      minimumScore: guide.selection.minimumScore ?? "",
    },
    tieBreakPriority: guide.tieBreakPriority,
    clarificationPolicy: guide.clarificationPolicy,
  };
}

async function phase4Api(payload: unknown) {
  const response = await fetch("/api/phase4", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const source = record(body);
    const errorBody = record(source?.error);
    throw new Error(
      stringValue(errorBody?.message, 500) ||
        "AI paused. Your data and approvals are unchanged; try again later.",
    );
  }
  const source = record(body);
  if (!source) throw new Error("The AI service returned an unreadable response.");
  return source;
}

function patternCanBeApproved(pattern: Phase4Pattern) {
  return (
    pattern.risk === "guide_aligned" &&
    pattern.supportingRowIds.length > 0 &&
    pattern.contradictingRowIds.length === 0 &&
    (pattern.kind === "criterion_anchor_example" ||
      pattern.kind === "eligibility_example" ||
      pattern.kind === "elimination_example")
  );
}

function normalizePattern(
  raw: unknown,
  rows: ReadonlyMap<string, Phase4SourceRow>,
  guide: Phase4ApprovedGuide,
): Phase4Pattern | null {
  const source = record(raw);
  if (!source) return null;
  const kind = stringValue(source.kind, 80);
  const risk = stringValue(source.risk, 80);
  const targetRuleId = stringValue(source.targetRuleId, 300);
  const ruleExists = guide.rules.some((rule) => rule.id === targetRuleId);
  if (!PATTERN_KINDS.has(kind) || !PATTERN_RISKS.has(risk)) return null;
  if (!ruleExists && kind !== "possible_policy_gap") return null;
  const patternKey = stringValue(source.patternKey, 200);
  const title = stringValue(source.title, 300);
  const proposedInterpretation = stringValue(source.proposedInterpretation, 2_000);
  if (!patternKey || !title || !proposedInterpretation) return null;

  const evidence = Array.isArray(source.evidence)
    ? source.evidence.flatMap((item) => {
        const evidenceSource = record(item);
        const rowId = stringValue(evidenceSource?.rowId, 300);
        const answerIndex = Number(evidenceSource?.answerIndex);
        const quote = stringValue(evidenceSource?.quote, 4_000);
        const row = rows.get(rowId);
        if (
          !row ||
          !Number.isInteger(answerIndex) ||
          answerIndex < 0 ||
          answerIndex >= row.answers.length ||
          !quote ||
          !row.answers[answerIndex].value.includes(quote)
        ) {
          return [];
        }
        return [{ rowId, answerIndex, quote }];
      })
    : [];
  if (evidence.length === 0) return null;
  const safeIds = (value: unknown) =>
    Array.isArray(value)
      ? [...new Set(value.map((item) => stringValue(item, 300)).filter((id) => rows.has(id)))]
      : [];
  return {
    id: `pattern:${targetRuleId || "gap"}:${patternKey}`,
    patternKey,
    kind: kind as Phase4Pattern["kind"],
    targetRuleId,
    title,
    proposedInterpretation,
    evidence,
    supportingRowIds: safeIds(source.supportingRowIds),
    contradictingRowIds: safeIds(source.contradictingRowIds),
    risk: risk as Phase4Pattern["risk"],
    decision: "pending",
    rejectionReason: "",
    decidedAt: null,
    decidedBy: null,
  };
}

function toStoredAssessment(
  rowId: string,
  result: ReturnType<typeof validateAiAssessmentBatch>["results"][string],
): StoredBlindAssessment {
  const assessment = result.assessment;
  return {
    rowId,
    eligibility:
      assessment?.eligibilityChecks.map((check) => ({
        ruleId: check.ruleId,
        status: check.result,
        evidence: check.evidence ? [check.evidence] : [],
      })) ?? [],
    elimination:
      assessment?.eliminationChecks.map((check) => ({
        ruleId: check.ruleId,
        status: check.result,
        evidence: check.evidence ? [check.evidence] : [],
      })) ?? [],
    criteria:
      assessment?.criterionScores.map((criterion) => ({
        criterionId: criterion.ruleId,
        score: criterion.score as 1 | 2 | 3 | 4 | 5 | null,
        evidence: criterion.evidence ? [criterion.evidence] : [],
      })) ?? [],
    weightedScore: result.weightedScore,
    recommendation: result.classification.recommendation,
    evidenceValid: result.evidenceValid,
    humanReviewReasons: [
      ...result.issues.map((issue) => issue.message),
      ...(assessment?.uncertainties ?? []),
    ],
  };
}

function rankedPredictions(
  session: Phase4Session,
): Map<string, StoredBlindAssessment["recommendation"]> {
  return new Map(
    session.assessments.map((assessment) => [assessment.rowId, assessment.recommendation]),
  );
}

function metricsForSession(session: Phase4Session) {
  if (!session.outcomes) throw new Error("Past outcomes have not been revealed.");
  if (!session.acceptancePolicy) throw new Error("The locked pass rules are missing.");
  return calculateLockedPracticeMetrics({
    assessments: session.assessments,
    outcomes: session.outcomes,
    policy: session.acceptancePolicy,
  });
}

function metricsMeetTargets(session: Phase4Session) {
  const metrics = session.metrics;
  const policy = session.acceptancePolicy;
  if (!metrics || !policy) return false;
  const alignmentMetric =
    policy.evaluationMode === "ranking_alignment"
      ? metrics.pairwiseRankingConcordance
      : metrics.agreement;
  return (
    metrics.evidenceValidRate.value === 100 &&
    alignmentMetric.value !== null &&
    alignmentMetric.value >= policy.minimumHistoricalAlignment &&
    metrics.progressedSafetyCapture.value !== null &&
    metrics.progressedSafetyCapture.value >= policy.minimumProgressedCapture &&
    metrics.humanReviewRate.value !== null &&
    metrics.humanReviewRate.value <= policy.maximumHumanReviewRate
  );
}

function practiceTargetsPass(session: Phase4Session) {
  return (
    Boolean(session.assessmentProtocolHash) &&
    metricsMeetTargets(session) &&
    session.evidenceReviewSampleIds.length > 0 &&
    session.evidenceReviewSampleIds.every((rowId) =>
      session.evidenceReviewRowIds.includes(rowId),
    )
  );
}

export function Phase4Workspace({
  datasetId,
  guide,
  organiserName,
  initialStep,
  onSummaryChange,
  onBack,
}: Phase4WorkspaceProps) {
  const [step, setStep] = useState<Phase4Step>(initialStep);
  const [session, setSession] = useState<Phase4Session | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [teachingConfirmation, setTeachingConfirmation] = useState(false);
  const [minimumAlignment, setMinimumAlignment] = useState("");
  const [minimumCapture, setMinimumCapture] = useState("100");
  const [maximumReview, setMaximumReview] = useState("");
  const [waitlistPolicy, setWaitlistPolicy] = useState<"exclude" | "not_progressed">("exclude");
  const [recalibrationCredits, setRecalibrationCredits] = useState(0);
  const [resetContext, setResetContext] = useState<{
    binding: Awaited<ReturnType<typeof loadHistoricalDatasetBinding>>;
    guideContentHash: string;
  } | null>(null);
  const [evidenceReviewAnswers, setEvidenceReviewAnswers] = useState<
    Map<string, Phase4SourceRow["answers"]>
  >(new Map());

  // The parent may pass a fresh onSummaryChange/guide identity on every render.
  // Read them through refs so the mount effect below depends only on the values
  // that should actually re-run it — otherwise its own onSummaryChange call
  // re-renders the parent and the effect loops forever.
  const onSummaryChangeRef = useRef(onSummaryChange);
  const guideRef = useRef(guide);
  useEffect(() => {
    onSummaryChangeRef.current = onSummaryChange;
    guideRef.current = guide;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const guide = guideRef.current;
        const onSummaryChange = onSummaryChangeRef.current;
        const binding = await loadHistoricalDatasetBinding(datasetId);
        if (binding.guideVersion !== guide.version || guide.status !== "approved") {
          throw new Error("Phase 4 is locked because the approved guide and historical set do not match.");
        }
        const guideContentHash = await createPhase4InputFingerprint(guide);
        let loaded = await loadPhase4Session(datasetId, guide.version);
        if (loaded && loaded.guideContentHash !== guideContentHash) {
          throw new Error("Phase 4 is locked because the approved Decision Guide changed.");
        }
        if (!loaded) {
          loaded = await createPhase4Session({ binding, guideContentHash });
          loaded = await savePhase4Session(loaded);
        }
        if (cancelled) return;
        setResetContext({ binding, guideContentHash });
        setRecalibrationCredits(await loadPhase4RecalibrationCredits(binding.datasetFingerprint));
        if (cancelled) return;
        setSession(loaded);
        if (loaded.acceptancePolicy) {
          setMinimumAlignment(String(loaded.acceptancePolicy.minimumHistoricalAlignment));
          setMinimumCapture(String(loaded.acceptancePolicy.minimumProgressedCapture));
          setMaximumReview(String(loaded.acceptancePolicy.maximumHumanReviewRate));
          setWaitlistPolicy(loaded.acceptancePolicy.waitlistPolicy);
        }
        onSummaryChange(phase4SummaryFromSession(loaded));
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Phase 4 could not be opened.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // guide and onSummaryChange are read via refs; the effect should re-run only
    // when the dataset or the approved guide version changes (the parent also
    // remounts this component on a version change).
  }, [datasetId, guide.version]);

  async function checkConnection() {
    setConnection("checking");
    setConnectionMessage("");
    try {
      const response = await fetch("/api/phase4", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as unknown;
      const source = record(body);
      const ai = record(source?.ai);
      const assessmentProtocolHash = stringValue(source?.assessmentProtocolHash, 64);
      if (
        response.ok &&
        ai?.configured === true &&
        /^[a-f0-9]{64}$/.test(assessmentProtocolHash) &&
        (!session?.assessmentProtocolHash ||
          session.assessmentProtocolHash === assessmentProtocolHash)
      ) {
        setConnection("connected");
        return;
      }
      setConnection("not_connected");
      setConnectionMessage(
        session?.assessmentProtocolHash &&
          assessmentProtocolHash &&
          session.assessmentProtocolHash !== assessmentProtocolHash
          ? "The assessment protocol changed. Start a new calibration before continuing."
          : stringValue(ai?.message, 500) || stringValue(record(source?.error)?.message, 500),
      );
    } catch {
      setConnection("unavailable");
      setConnectionMessage("The connection check could not reach Minder’s server.");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/phase4", { cache: "no-store" })
      .then(async (response) => ({
        response,
        body: (await response.json().catch(() => null)) as unknown,
      }))
      .then(({ response, body }) => {
        if (cancelled) return;
        const source = record(body);
        const ai = record(source?.ai);
        const assessmentProtocolHash = stringValue(source?.assessmentProtocolHash, 64);
        if (
          response.ok &&
          ai?.configured === true &&
          /^[a-f0-9]{64}$/.test(assessmentProtocolHash) &&
          (!session?.assessmentProtocolHash ||
            session.assessmentProtocolHash === assessmentProtocolHash)
        ) {
          setConnection("connected");
          return;
        }
        setConnection("not_connected");
        setConnectionMessage(
          session?.assessmentProtocolHash &&
            assessmentProtocolHash &&
            session.assessmentProtocolHash !== assessmentProtocolHash
            ? "The assessment protocol changed. Start a new calibration before continuing."
            : stringValue(ai?.message, 500) || stringValue(record(source?.error)?.message, 500),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setConnection("unavailable");
        setConnectionMessage("The connection check could not reach Minder’s server.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.assessmentProtocolHash]);

  useEffect(() => {
    let cancelled = false;
    if (!session?.metrics || session.evidenceReviewSampleIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }
    void loadBlindPracticeRows(datasetId)
      .then((rows) => {
        if (cancelled) return;
        const sample = new Set(session.evidenceReviewSampleIds);
        setEvidenceReviewAnswers(
          new Map(
            rows
              .filter((row) => sample.has(row.rowId))
              .map((row) => [row.rowId, row.answers]),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setEvidenceReviewAnswers(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, session?.evidenceReviewSampleIds, session?.metrics]);

  async function persist(next: Phase4Session) {
    const saved = await savePhase4Session(next);
    setSession(saved);
    onSummaryChange(phase4SummaryFromSession(saved));
    return saved;
  }

  async function recalibrateWithCredit() {
    if (!resetContext || recalibrationCredits < 1 || busy) return;
    if (
      !window.confirm(
        "Use your one recalibration retry to run the practice test again on this same historical file? The earlier reveal stays in the permanent record, and this retry is no longer strictly blind.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fresh = await resetPhase4SessionWithCredit(resetContext);
      setRecalibrationCredits(await loadPhase4RecalibrationCredits(resetContext.binding.datasetFingerprint));
      setMinimumAlignment("");
      setMinimumCapture("100");
      setMaximumReview("");
      setWaitlistPolicy("exclude");
      setSession(fresh);
      setStep("test");
      onSummaryChange(phase4SummaryFromSession(fresh));
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "The recalibration retry could not start.");
    } finally {
      setBusy(false);
    }
  }

  async function generatePatterns() {
    if (!session || connection !== "connected" || busy) return;
    setBusy(true);
    setError("");
    try {
      const teachingRows = (await loadTeachingRows(datasetId)).sort((a, b) =>
        a.rowId.localeCompare(b.rowId),
      );
      const safeRows = buildSafeTeachingPayload(teachingRows);
      let working: Phase4Session = {
        ...session,
        patternStatus: "generating",
        patternProcessedRows: session.patternProcessedRows || 0,
        patternProgress: session.patternProgress || 0,
      };
      working = await persist(working);
      for (
        let index = working.patternProcessedRows;
        index < safeRows.length;
        index += TEACHING_BATCH_SIZE
      ) {
        const batch = safeRows.slice(index, index + TEACHING_BATCH_SIZE);
        const body = await phase4Api({
          action: "discover_patterns",
          guide: guideForAi(guide),
          rows: batch,
        });
        const result = record(body.result);
        const rawPatterns = Array.isArray(result?.patterns) ? result.patterns : [];
        const limitations = Array.isArray(result?.limitations)
          ? result.limitations
              .map((item) => stringValue(item, 500))
              .filter(Boolean)
          : [];
        const batchRows = new Map(
          teachingRows
            .slice(index, index + TEACHING_BATCH_SIZE)
            .map((row) => [row.rowId, row as Phase4SourceRow]),
        );
        const incoming = rawPatterns
          .map((item) => normalizePattern(item, batchRows, guide))
          .filter((pattern): pattern is Phase4Pattern => Boolean(pattern));
        const model = stringValue(body.model, 200);
        if (working.modelId && model && model !== working.modelId) {
          throw new Error("The AI model changed during calibration. Minder stopped without substituting it.");
        }
        working = {
          ...working,
          modelId: working.modelId ?? model ?? null,
          patterns: mergePhase4Patterns(working.patterns, incoming, MAX_REVIEW_PATTERNS),
          patternLimitations: [
            ...new Set([...working.patternLimitations, ...limitations]),
          ].slice(0, 20),
          patternProcessedRows: Math.min(index + batch.length, safeRows.length),
          patternProgress: Math.round((Math.min(index + batch.length, safeRows.length) / safeRows.length) * 100),
        };
        working = await persist(working);
      }
      working = { ...working, patternStatus: "reviewing", patternProgress: 100 };
      await persist(working);
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "AI paused. Your saved progress is unchanged.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function decidePattern(
    patternId: string,
    decision: "approved" | "rejected",
    rejectionReason = "",
  ) {
    if (!session || session.patternStatus === "approved" || busy) return;
    setBusy(true);
    const now = new Date().toISOString();
    const next = {
      ...session,
      patterns: session.patterns.map((pattern) =>
        pattern.id === patternId
          ? {
              ...pattern,
              decision,
              rejectionReason: decision === "rejected" ? rejectionReason : "",
              decidedAt: now,
              decidedBy: organiserName,
            }
          : pattern,
      ),
    } satisfies Phase4Session;
    try {
      await persist(next);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error ? decisionError.message : "This decision was not saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function approveTeaching() {
    if (!session || !teachingConfirmation || busy) return;
    if (session.patterns.some((pattern) => pattern.decision === "pending")) return;
    const now = new Date().toISOString();
    await persist({
      ...session,
      patternStatus: "approved",
      teachingApprovedAt: now,
      teachingApprovedBy: organiserName,
    });
    setStep("test");
  }

  async function lockPolicy() {
    if (!session || session.patternStatus !== "approved" || busy) return;
    const values = [minimumAlignment, minimumCapture, maximumReview].map(Number);
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 100)) {
      setError("Enter a whole percentage from 0 to 100 for every pass rule.");
      return;
    }
    if (values[1] < 90) {
      setError(
        "The previously-progressed capture floor cannot be set below 90%. Missing more than one in ten past successes is not a calibration worth trusting.",
      );
      return;
    }
    if (
      !window.confirm(
        "Lock these pass rules? They cannot change after the sealed practice test starts.",
      )
    ) {
      return;
    }
    const policy: PracticeAcceptancePolicy = {
      evaluationMode:
        guide.selection.mode === "top_n" || guide.selection.mode === "both"
          ? "ranking_alignment"
          : "binary_alignment",
      minimumHistoricalAlignment: values[0],
      minimumProgressedCapture: values[1],
      maximumHumanReviewRate: values[2],
      waitlistPolicy,
      tieBreakPriority: [...guide.tieBreakPriority],
      lockedAt: new Date().toISOString(),
      lockedBy: organiserName,
    };
    await persist({ ...session, acceptancePolicy: policy, practiceStatus: "policy_locked" });
  }

  async function runPracticeTest() {
    if (
      !session ||
      !session.acceptancePolicy ||
      connection !== "connected" ||
      busy ||
      (session.practiceStatus !== "policy_locked" && session.practiceStatus !== "running")
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const currentProtocolHash = await getPhase4AssessmentProtocolHash();
      if (
        session.assessmentProtocolHash &&
        session.assessmentProtocolHash !== currentProtocolHash
      ) {
        throw new Error(
          "The assessment prompt or schema changed. Start a new calibration before continuing.",
        );
      }
      const cases = (await loadBlindPracticeRows(datasetId)).sort((a, b) =>
        a.rowId.localeCompare(b.rowId),
      );
      const safeCases = buildBlindSealedPayload(cases);
      let working: Phase4Session = { ...session, practiceStatus: "running" };
      working = await persist(working);
      const completed = new Set(working.assessments.map((assessment) => assessment.rowId));
      for (let index = 0; index < safeCases.length; index += PRACTICE_BATCH_SIZE) {
        const sourceBatch = cases.slice(index, index + PRACTICE_BATCH_SIZE);
        if (sourceBatch.every((item) => completed.has(item.rowId))) continue;
        const batch = safeCases.slice(index, index + PRACTICE_BATCH_SIZE);
        const body = await phase4Api({
          action: "assess_cases",
          guide: guideForAi(guide),
          cases: batch,
          approvedPatterns: working.patterns
            .filter((pattern) => pattern.decision === "approved")
            .map((pattern) => ({
              id: pattern.id,
              targetRuleId: pattern.targetRuleId,
              proposedInterpretation: pattern.proposedInterpretation,
            })),
        });
        const model = stringValue(body.model, 200);
        const assessmentProtocolHash = stringValue(body.assessmentProtocolHash, 64);
        if (!/^[a-f0-9]{64}$/.test(assessmentProtocolHash)) {
          throw new Error("The AI service did not return the locked assessment-protocol receipt.");
        }
        if (working.modelId && model && model !== working.modelId) {
          throw new Error("The AI model changed during the blind run. Minder stopped without substituting it.");
        }
        if (
          working.assessmentProtocolHash &&
          assessmentProtocolHash !== working.assessmentProtocolHash
        ) {
          throw new Error("The AI assessment protocol changed during the blind run. Minder stopped safely.");
        }
        const validation = validateAiAssessmentBatch(
          body.result,
          sourceBatch,
          guide,
        );
        const additions = sourceBatch.map((item) =>
          toStoredAssessment(item.rowId, validation.results[item.rowId]),
        );
        const additionsById = new Map(additions.map((item) => [item.rowId, item]));
        working = {
          ...working,
          modelId: working.modelId ?? model ?? null,
          assessmentProtocolHash:
            working.assessmentProtocolHash ?? assessmentProtocolHash,
          assessments: [
            ...working.assessments.filter((item) => !additionsById.has(item.rowId)),
            ...additions,
          ].sort((a, b) => a.rowId.localeCompare(b.rowId)),
        };
        additions.forEach((item) => completed.add(item.rowId));
        working = await persist(working);
      }
      if (working.assessments.length !== cases.length) {
        throw new Error("Not every sealed case received a locked assessment. Outcomes remain hidden.");
      }
      const predictionHash = await createPhase4InputFingerprint(working.assessments);
      working = { ...working, predictionHash, practiceStatus: "predictions_committed" };
      await persist(working);
    } catch (runError) {
      setError(
        runError instanceof Error
          ? runError.message
          : "AI paused. Completed batches are saved and outcomes remain hidden.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revealAndCompare() {
    if (!session || busy) return;
    if (
      !window.confirm(
        "Reveal the historical outcomes now? This sealed set will be permanently consumed and cannot be called blind again.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      let revealed = await revealCommittedOutcomes(session);
      const metrics = metricsForSession(revealed);
      const evidenceReviewSampleIds = selectEvidenceReviewSampleIds(revealed.assessments);
      const metricsHash = await createPhase4InputFingerprint({
        assessments: revealed.assessments,
        outcomes: revealed.outcomes,
        acceptancePolicy: revealed.acceptancePolicy,
        metrics,
        evidenceReviewSampleIds,
        assessmentProtocolHash: revealed.assessmentProtocolHash,
      });
      revealed = {
        ...revealed,
        metrics,
        metricsHash,
        evidenceReviewSampleIds,
        evidenceReviewRowIds: [],
      };
      await persist(revealed);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : "Results could not be revealed.");
    } finally {
      setBusy(false);
    }
  }

  async function recoverMetrics() {
    if (!session?.outcomes || session.metrics || busy) return;
    const metrics = metricsForSession(session);
    const evidenceReviewSampleIds = selectEvidenceReviewSampleIds(session.assessments);
    const metricsHash = await createPhase4InputFingerprint({
      assessments: session.assessments,
      outcomes: session.outcomes,
      acceptancePolicy: session.acceptancePolicy,
      metrics,
      evidenceReviewSampleIds,
      assessmentProtocolHash: session.assessmentProtocolHash,
    });
    const next = {
      ...session,
      metrics,
      metricsHash,
      evidenceReviewSampleIds,
      evidenceReviewRowIds: [],
    };
    await persist(next);
  }

  async function confirmEvidenceRelevance(rowId: string) {
    if (
      !session?.metrics ||
      session.practiceStatus !== "revealed" ||
      session.evidenceReviewRowIds.includes(rowId) ||
      !session.evidenceReviewSampleIds.includes(rowId) ||
      busy
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await persist({
        ...session,
        evidenceReviewRowIds: [...session.evidenceReviewRowIds, rowId].sort(),
      });
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : "The evidence review was not saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function decidePractice(decision: "passed" | "failed") {
    if (!session?.metrics || busy) return;
    if (decision === "passed" && !practiceTargetsPass(session)) return;
    const now = new Date().toISOString();
    await persist({
      ...session,
      practiceStatus: decision,
      finalDecisionAt: now,
      finalDecisionBy: organiserName,
    });
  }

  const resolvedPatterns = session?.patterns.filter((pattern) => pattern.decision !== "pending").length ?? 0;
  const approvedPatterns = session?.patterns.filter((pattern) => pattern.decision === "approved").length ?? 0;
  const rejectedPatterns = session?.patterns.filter((pattern) => pattern.decision === "rejected").length ?? 0;
  const allPatternsResolved = session ? resolvedPatterns === session.patterns.length : false;
  const metricTargetsPass = Boolean(session && metricsMeetTargets(session));
  const targetsPass = Boolean(session && practiceTargetsPass(session));
  const outcomeById = useMemo(
    () => new Map(session?.outcomes?.map((item) => [item.rowId, item.outcome]) ?? []),
    [session?.outcomes],
  );
  const predictionById = useMemo(
    () => (session ? rankedPredictions(session) : new Map()),
    [session],
  );

  return (
    <div className="phase4-page">
      <header className="phase4-header">
        <button className="back-button" type="button" onClick={onBack}>← Setup journey</button>
        <div>
          <span className="section-kicker">Phase 04 · Controlled calibration</span>
          <h2>{step === "teach" ? "Review what history suggests" : "Run a blind practice test"}</h2>
          <p>
            {step === "teach"
              ? "Minder proposes possible patterns from the teaching set. You decide whether any are safe guidance."
              : "Decide what good enough means before Minder compares locked recommendations with past outcomes."}
          </p>
        </div>
        <div className="phase4-switch" aria-label="Phase 4 steps">
          <button className={step === "teach" ? "active" : ""} type="button" onClick={() => setStep("teach")}>04 Teach</button>
          <button
            className={step === "test" ? "active" : ""}
            type="button"
            disabled={session?.patternStatus !== "approved"}
            onClick={() => setStep("test")}
          >05 Test</button>
        </div>
      </header>

      <section className="phase4-warning">
        <strong>{step === "teach" ? "Patterns are clues, not rules." : "Historical agreement is not truth."}</strong>
        <p>
          {step === "teach"
            ? "Past decisions may contain inconsistency or bias. Approved patterns can only clarify an existing rule; they cannot change weights, thresholds or safeguards."
            : "A disagreement may be an AI error, an unclear rule or an inconsistent past decision. Passing still permits only supervised use."}
        </p>
      </section>

      {error ? <div className="phase4-error" role="alert"><strong>Stopped safely</strong><span>{error}</span></div> : null}

      <div className="phase4-layout">
        <main className="phase4-main">
          {!session ? (
            <section className="phase4-card"><h3>Checking your sealed workspace…</h3><p>No data is being sent while this check runs.</p></section>
          ) : step === "teach" ? (
            <>
              <section className="phase4-card phase4-summary-card">
                <div>
                  <span className="section-kicker">Prepare</span>
                  <h3>Verified teaching set</h3>
                  <p>{session.teachingRows.toLocaleString()} labelled examples can be reviewed. The {session.sealedRows.toLocaleString()} practice cases remain hidden.</p>
                </div>
                <dl className="phase4-facts">
                  <div><dt>Decision Guide</dt><dd>Version {session.guideVersion}</dd></div>
                  <div><dt>Data seal</dt><dd>{shortFingerprint(session.datasetFingerprint)}</dd></div>
                  <div><dt>Connection</dt><dd className={`connection-${connection}`}>{connection === "connected" ? "AI connected" : connection === "checking" ? "Checking…" : "Not connected"}</dd></div>
                </dl>
              </section>

              {connection !== "connected" ? (
                <section className="phase4-card phase4-connection-card">
                  <span className="phase4-status-badge warning">AI service not connected</span>
                  <h3>No pattern review can run yet</h3>
                  <p>This preview can organise historical data, but it cannot generate real patterns or run a practice test. No application text has been sent to OpenAI.</p>
                  <p className="phase4-note">A Minder administrator connects the OpenAI API once on the server. Reviewers never handle API keys, and a ChatGPT subscription does not provide API access.</p>
                  {connectionMessage ? <p className="phase4-inline-error">{connectionMessage}</p> : null}
                  <button className="secondary-button" type="button" onClick={() => void checkConnection()} disabled={connection === "checking"}>Check connection</button>
                </section>
              ) : (
                <section className="phase4-card phase4-privacy-card">
                  <span className="phase4-status-badge safe">Server connection verified</span>
                  <h3>Before sending teaching examples</h3>
                  <p>Only pseudonymous row IDs, mapped answers and historical outcomes are sent through Minder’s server. Separate identity columns, reviewer notes, judge scores, year and track are excluded.</p>
                  <p className="phase4-note">Mapped answer text is sent exactly as written and may itself contain names or contact details. Remove those details before import. This prototype remains test-data-only.</p>
                  <p className="phase4-note">API data is not used to train OpenAI models by default unless the organisation opts in. Retention depends on the organisation’s OpenAI project and controls; this app does not claim zero retention.</p>
                </section>
              )}

              {session.patternStatus === "not_started" || session.patternStatus === "generating" ? (
                <section className="phase4-card">
                  <span className="section-kicker">Generate review</span>
                  <h3>{session.patternStatus === "generating" ? "Pattern review paused" : "Scan every teaching example"}</h3>
                  <p>Minder reads the teaching set in small fixed batches, checks suggestions against existing rule IDs, and discards any quotation it cannot verify exactly.</p>
                  {session.patternStatus === "generating" ? (
                    <div className="phase4-progress"><span style={{ width: `${session.patternProgress}%` }} /><em>{session.patternProgress}% saved</em></div>
                  ) : null}
                  <button className="primary-button" type="button" onClick={() => void generatePatterns()} disabled={connection !== "connected" || busy}>
                    {busy ? `Analysing… ${session.patternProgress}%` : session.patternStatus === "generating" ? "Resume pattern review" : "Generate pattern review"}
                  </button>
                </section>
              ) : null}

              {session.patternStatus === "reviewing" || session.patternStatus === "approved" ? (
                <section className="phase4-card">
                  <div className="phase4-card-heading">
                    <div><span className="section-kicker">Review patterns</span><h3>{session.patterns.length ? "Decide one by one" : "No reliable patterns found"}</h3></div>
                    <span className="phase4-counter">{resolvedPatterns}/{session.patterns.length} resolved</span>
                  </div>
                  {session.patterns.length === 0 ? <p>That is a valid result. You can continue using the approved Decision Guide alone; Minder will not invent teaching guidance.</p> : null}
                  {session.patternLimitations.length ? (
                    <div className="phase4-inline-warning"><strong>Limitations reported during the scan</strong><ul>{session.patternLimitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>
                  ) : null}
                  <div className="phase4-pattern-list">
                    {session.patterns.map((pattern) => {
                      const rule = guide.rules.find((item) => item.id === pattern.targetRuleId);
                      const unsafe = !patternCanBeApproved(pattern);
                      return (
                        <article className={`phase4-pattern pattern-${pattern.decision}`} key={pattern.id}>
                          <div className="phase4-pattern-top">
                            <span className={`phase4-status-badge ${unsafe ? "warning" : "safe"}`}>{unsafe ? "Needs caution" : "Guide-aligned example"}</span>
                            <span>{pattern.supportingRowIds.length} supporting · {pattern.contradictingRowIds.length} counterexamples</span>
                          </div>
                          <h4>{pattern.title}</h4>
                          <p>{pattern.proposedInterpretation}</p>
                          <div className="phase4-rule-link"><strong>Existing rule:</strong> {rule?.title ?? "No existing rule — revise the guide first"}</div>
                          {pattern.evidence.slice(0, 2).map((evidence, index) => (
                            <blockquote key={`${pattern.id}-evidence-${index}`}>“{evidence.quote}”<small>Verified excerpt · anonymous teaching example</small></blockquote>
                          ))}
                          {pattern.decision === "pending" ? (
                            <div className="phase4-pattern-actions">
                              <button className="secondary-button" type="button" disabled={unsafe || busy} onClick={() => void decidePattern(pattern.id, "approved")}>Approve as guidance</button>
                              <select
                                aria-label={`Reason for rejecting ${pattern.title}`}
                                value={pattern.rejectionReason}
                                onChange={(event) => {
                                  setSession((current) => current ? { ...current, patterns: current.patterns.map((item) => item.id === pattern.id ? { ...item, rejectionReason: event.target.value } : item) } : current);
                                }}
                              >
                                <option value="">Choose rejection reason</option>
                                {REJECTION_REASONS.map((reason) => <option key={reason}>{reason}</option>)}
                              </select>
                              <button className="danger-button" type="button" disabled={!pattern.rejectionReason || busy} onClick={() => void decidePattern(pattern.id, "rejected", pattern.rejectionReason)}>Reject pattern</button>
                            </div>
                          ) : (
                            <div className={`phase4-decision decision-${pattern.decision}`}>{pattern.decision === "approved" ? "Approved as optional guidance" : `Rejected · ${pattern.rejectionReason}`}</div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                  {session.patternStatus !== "approved" ? (
                    <div className="phase4-approval-box">
                      <p><strong>{approvedPatterns} approved · {rejectedPatterns} rejected · {session.patterns.length - resolvedPatterns} unresolved</strong></p>
                      <label className="check-row"><input type="checkbox" checked={teachingConfirmation} onChange={(event) => setTeachingConfirmation(event.target.checked)} /><span>I reviewed every proposal and reported limitation, and confirm approved guidance only clarifies existing rules. Decision Guide Version {guide.version} remains unchanged.</span></label>
                      <button className="primary-button" type="button" onClick={() => void approveTeaching()} disabled={!allPatternsResolved || !teachingConfirmation || busy}>Approve teaching guidance</button>
                    </div>
                  ) : <div className="phase4-approved-box"><strong>Teaching guidance approved</strong><span>{approvedPatterns ? `${approvedPatterns} optional patterns are frozen.` : "Decision Guide only; no historical patterns were added."}</span></div>}
                </section>
              ) : null}
            </>
          ) : (
            <>
              <section className="phase4-card phase4-summary-card">
                <div><span className="section-kicker">Blind practice set</span><h3>{session.sealedRows.toLocaleString()} outcomes remain sealed</h3><p>All evidence findings and scores must be saved before any historical result is revealed.</p></div>
                <dl className="phase4-facts"><div><dt>Teaching guidance</dt><dd>{approvedPatterns} approved</dd></div><div><dt>Run state</dt><dd>{session.practiceStatus.replaceAll("_", " ")}</dd></div><div><dt>Predictions</dt><dd>{session.assessments.length}/{session.sealedRows}</dd></div></dl>
              </section>

              {session.blindnessCompromised ? (
                <div className="history-alert" role="status">
                  <strong>This practice test is not strictly blind.</strong>
                  <p>The historical outcomes for this file were revealed once before, and this recalibration was permitted because a supervised run failed its human evidence audit. The earlier reveal stays in the permanent record; treat this pass as a supervised-recalibration check, not a fresh blind result.</p>
                </div>
              ) : null}

              {recalibrationCredits > 0 &&
              (session.practiceStatus === "failed" ||
                session.practiceStatus === "revealed" ||
                session.practiceStatus === "passed") ? (
                <div className="phase4-card phase4-recalibrate-card">
                  <div><span className="section-kicker">Recalibration retry available</span><h3>Rerun the practice test on this same file</h3><p>A supervised run failed its evidence audit, so you have one retry on this historical set instead of needing a new one. Revise the Decision Guide or teaching guidance first if the failure pointed to a rule problem. The previous reveal is kept in the permanent record.</p></div>
                  <button className="primary-button" type="button" disabled={busy} onClick={() => void recalibrateWithCredit()}>{busy ? "Starting retry…" : "Start recalibration retry"}</button>
                </div>
              ) : null}

              {session.practiceStatus === "not_started" ? (
                <section className="phase4-card">
                  <span className="section-kicker">1 · Set pass rules</span>
                  <h3>Choose the required historical alignment</h3>
                  <p>These are evaluation targets, not competition scoring rules. Enter them before the sealed cases are assessed.</p>
                  <div className="phase4-hard-rules"><strong>Fixed safety requirements</strong><ul><li>100% of numeric-score evidence must be an exact quote from the current answer.</li><li>Missing, conflicting or unsupported evidence goes to Human Review.</li><li>Every rule finding and score is locked before outcomes are revealed.</li><li>Top-N guides are tested by ranking agreement; the answer key never chooses a cutoff.</li><li>No automatic final rejection or shortlist.</li></ul></div>
                  <div className="phase4-policy-grid">
                    <label><span>{guide.selection.mode === "top_n" || guide.selection.mode === "both" ? "Minimum ranking agreement" : "Minimum overall historical alignment"}</span><div><input type="number" min="0" max="100" value={minimumAlignment} onChange={(event) => setMinimumAlignment(event.target.value)} /><em>%</em></div></label>
                    <label><span>Previously progressed safely captured · 90–100</span><div><input type="number" min={90} max={100} value={minimumCapture} disabled={busy} onChange={(event) => setMinimumCapture(event.target.value)} /><em>%</em></div><small>100% is strictest. Historical decisions are often noisy — judges sometimes disagreed with their own rubric — so a realistic floor (for example 95%) avoids failing the one-use test over a single arguable old case.</small></label>
                    <label><span>Maximum Human Review workload</span><div><input type="number" min="0" max="100" value={maximumReview} onChange={(event) => setMaximumReview(event.target.value)} /><em>%</em></div></label>
                    <label><span>Waitlist comparison</span><select value={waitlistPolicy} onChange={(event) => setWaitlistPolicy(event.target.value as "exclude" | "not_progressed")}><option value="exclude">Show separately; exclude</option><option value="not_progressed">Treat as did not progress</option></select></label>
                  </div>
                  <button className="primary-button" type="button" onClick={() => void lockPolicy()} disabled={busy || !minimumAlignment || !minimumCapture || !maximumReview}>Lock test plan</button>
                </section>
              ) : null}

              {session.practiceStatus === "policy_locked" || session.practiceStatus === "running" ? (
                <section className="phase4-card">
                  <span className="section-kicker">2 · Run test</span>
                  <h3>{session.practiceStatus === "running" ? "Blind run paused safely" : "Pass rules are locked"}</h3>
                  <p>Minder will receive pseudonymous row IDs, mapped answer text and approved guidance. Historical outcomes stay in the sealed store.</p>
                  <div className="phase4-progress"><span style={{ width: `${session.sealedRows ? (session.assessments.length / session.sealedRows) * 100 : 0}%` }} /><em>{session.assessments.length}/{session.sealedRows} saved</em></div>
                  {connection !== "connected" ? <div className="phase4-inline-warning"><strong>AI service not connected.</strong> No application text has been sent.</div> : null}
                  <button className="primary-button" type="button" onClick={() => void runPracticeTest()} disabled={connection !== "connected" || busy}>{busy ? "Assessing sealed cases…" : session.practiceStatus === "running" ? "Resume identical run" : "Start blind practice test"}</button>
                </section>
              ) : null}

              {session.practiceStatus === "predictions_committed" ? (
                <section className="phase4-card phase4-commit-card"><span className="phase4-status-badge safe">Predictions locked</span><h3>Every result is committed</h3><p>The prediction fingerprint is {shortFingerprint(session.predictionHash ?? "")}. Reveal will permanently consume this test set.</p><button className="primary-button" type="button" onClick={() => void revealAndCompare()} disabled={busy}>Reveal outcomes and compare</button></section>
              ) : null}

              {session.outcomes && !session.metrics ? (
                <section className="phase4-card"><h3>Outcomes revealed; finishing comparison</h3><p>The immutable prediction set is safe. Recalculate the metrics without calling AI again.</p><button className="secondary-button" type="button" onClick={() => void recoverMetrics()}>Calculate saved results</button></section>
              ) : null}

              {session.metrics ? (
                <section className="phase4-card">
                  <div className="phase4-card-heading"><div><span className="section-kicker">3 · Inspect results</span><h3>{targetsPass ? "Safety and target checks passed" : metricTargetsPass ? "Human evidence review remains" : "Not ready for supervised use"}</h3></div><span className={`phase4-status-badge ${targetsPass ? "safe" : metricTargetsPass ? "warning" : "danger"}`}>{targetsPass ? "Ready to decide" : metricTargetsPass ? "Review required" : "Targets missed"}</span></div>
                  <p>These numbers show alignment with past decisions, not objective correctness. Every denominator remains visible.</p>
                  <div className="phase4-metrics">
                    {[
                      ["Exact evidence", session.metrics.evidenceValidRate, "100% required"],
                      ["Historical alignment", session.metrics.agreement, session.acceptancePolicy?.evaluationMode === "binary_alignment" ? `Target ≥ ${session.acceptancePolicy.minimumHistoricalAlignment}%` : "Diagnostic only"],
                      ["Previously progressed safely captured", session.metrics.progressedSafetyCapture, `Target ≥ ${session.acceptancePolicy?.minimumProgressedCapture ?? 100}%`],
                      ["Exact progressed alignment", session.metrics.progressedRecall, "Diagnostic only"],
                      ["Human Review", session.metrics.humanReviewRate, `Target ≤ ${session.acceptancePolicy?.maximumHumanReviewRate}%`],
                      ["Ranking agreement", session.metrics.pairwiseRankingConcordance, session.acceptancePolicy?.evaluationMode === "ranking_alignment" ? `Target ≥ ${session.acceptancePolicy.minimumHistoricalAlignment}%` : "Diagnostic only"],
                    ].map(([label, metric, target]) => {
                      const item = metric as typeof session.metrics.agreement;
                      return <article key={label as string}><span>{label as string}</span><strong>{percentText(item.value)}</strong><small>{item.numerator}/{item.denominator} · {target as string}</small></article>;
                    })}
                  </div>
                  <div className="phase4-evidence-review">
                    <div className="phase4-card-heading">
                      <div>
                        <span className="section-kicker">4 · Human relevance check</span>
                        <h4>Confirm a fixed sample of evidence</h4>
                      </div>
                      <span className="phase4-counter">{session.evidenceReviewRowIds.length}/{session.evidenceReviewSampleIds.length} checked</span>
                    </div>
                    <p>An exact quote proves the words exist, not that they justify the rule finding. A person must check this fixed sample before Minder can pass.</p>
                    {session.evidenceReviewSampleIds.length === 0 ? (
                      <div className="phase4-inline-warning"><strong>No evidence-bearing decisions are available to audit.</strong> This run cannot pass; mark it not ready and revise the guide or AI instructions.</div>
                    ) : (
                      <div className="phase4-evidence-sample">
                        {session.evidenceReviewSampleIds.map((rowId, index) => {
                          const assessment = session.assessments.find((item) => item.rowId === rowId);
                          const answers = evidenceReviewAnswers.get(rowId);
                          const findings = assessment
                            ? [
                                ...assessment.eligibility.flatMap((finding) =>
                                  finding.evidence.map((evidence) => ({
                                    ruleId: finding.ruleId,
                                    result: finding.status.replaceAll("_", " "),
                                    evidence,
                                  })),
                                ),
                                ...assessment.elimination.flatMap((finding) =>
                                  finding.evidence.map((evidence) => ({
                                    ruleId: finding.ruleId,
                                    result: finding.status.replaceAll("_", " "),
                                    evidence,
                                  })),
                                ),
                                ...assessment.criteria.flatMap((finding) =>
                                  finding.evidence.map((evidence) => ({
                                    ruleId: finding.criterionId,
                                    result: finding.score === null ? "no score" : `score ${finding.score}/5`,
                                    evidence,
                                  })),
                                ),
                              ]
                            : [];
                          const reviewed = session.evidenceReviewRowIds.includes(rowId);
                          return (
                            <article className={reviewed ? "reviewed" : ""} key={rowId}>
                              <div className="phase4-evidence-case-title">
                                <strong>Evidence sample {index + 1}</strong>
                                <span>{findings.length} finding{findings.length === 1 ? "" : "s"}</span>
                              </div>
                              {findings.map((finding, findingIndex) => {
                                const rule = guide.rules.find((item) => item.id === finding.ruleId);
                                const heading = answers?.[finding.evidence.answerIndex]?.heading;
                                return (
                                  <div className="phase4-evidence-finding" key={`${rowId}-${finding.ruleId}-${findingIndex}`}>
                                    <p><strong>{rule?.title ?? "Unknown rule"}</strong> · {finding.result}</p>
                                    <small>{rule?.statement}</small>
                                    <blockquote>“{finding.evidence.quote}”<small>{heading ? `From: ${heading}` : "Verified application excerpt"}</small></blockquote>
                                  </div>
                                );
                              })}
                              <label className="check-row">
                                <input
                                  type="checkbox"
                                  checked={reviewed}
                                  disabled={reviewed || busy || session.practiceStatus !== "revealed"}
                                  onChange={(event) => {
                                    if (event.target.checked) void confirmEvidenceRelevance(rowId);
                                  }}
                                />
                                <span>I checked these quotes against the named rules. They are relevant to the findings shown.</span>
                              </label>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="phase4-case-list">
                    <h4>Cases needing attention</h4>
                    {session.assessments
                      .filter((assessment) => {
                        const historical = outcomeById.get(assessment.rowId);
                        const predicted = predictionById.get(assessment.rowId);
                        return (
                          !assessment.evidenceValid ||
                          predicted === "human_review" ||
                          (predicted !== "rank_only" &&
                            historical !== "waitlist" &&
                            predicted !== historical)
                        );
                      })
                      .slice(0, 20)
                      .map((assessment, index) => (
                        <article key={assessment.rowId}>
                          <div><strong>Practice case {String(index + 1).padStart(2, "0")}</strong><span>Past: {outcomeById.get(assessment.rowId)?.replaceAll("_", " ")} · Minder: {predictionById.get(assessment.rowId)?.replaceAll("_", " ")}</span></div>
                          <small>{assessment.humanReviewReasons[0] || "Historical outcome and recommendation differ."}</small>
                        </article>
                      ))}
                  </div>
                  {session.practiceStatus === "revealed" ? (
                    <div className="phase4-final-actions"><button className="primary-button" type="button" disabled={!targetsPass || busy} onClick={() => void decidePractice("passed")}>Approve for supervised pilot</button><button className="danger-button" type="button" disabled={busy} onClick={() => void decidePractice("failed")}>Mark not ready</button></div>
                  ) : <div className={`phase4-approved-box ${session.practiceStatus === "failed" ? "failed" : ""}`}><strong>{session.practiceStatus === "passed" ? "Approved for a supervised pilot" : "Not ready — live assessment remains locked"}</strong><span>A person still confirms every final decision.</span></div>}
                </section>
              ) : null}
            </>
          )}
        </main>

        <aside className="phase4-rail">
          <section className="rail-card"><div className="rail-label">Controls in this phase</div><ul className="phase4-rail-list"><li>Only approved rules and weights are supplied</li><li>Separate identity, year and track columns are excluded</li><li>Embedded details and writing style remain visible to AI</li><li>Unsupported evidence routes to Human Review</li><li>People make the final decision</li></ul></section>
          <section className="rail-card"><div className="rail-label">Version lock</div><p>Guide Version {guide.version}</p><p>Data {session ? shortFingerprint(session.datasetFingerprint) : "Checking…"}</p><p>Method {session?.outputSchemaVersion ?? "Checking…"}</p><p className="small-note">Changing any bound input invalidates this calibration.</p></section>
          <section className="rail-card"><div className="rail-label">Honest limitation</div><p className="small-note">Structured output controls the shape of an AI answer, not whether its claim is true. Exact matching proves a quote exists, not that it is relevant. Minder checks both automatically and through a fixed human sample.</p></section>
        </aside>
      </div>
    </div>
  );
}
