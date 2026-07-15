"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { HistoricalImportBuilder } from "./historical-import";
import {
  EMPTY_HISTORICAL_IMPORT,
  loadActiveHistoricalSummary,
  sanitizeHistoricalImportSummary,
} from "./historical-data";
import type { HistoricalImportSummary } from "./historical-data";

const LEGACY_STORAGE_KEY = "minder-net-zero-phase-1";
const V2_STORAGE_KEY = "minder-net-zero-app-v2";
const STORAGE_KEY = "minder-net-zero-app-v3";

type CompetitionDetails = {
  competitionName: string;
  roundName: string;
  organiserName: string;
  shortlistTarget: string;
};

type RuleKind = "eligibility" | "elimination" | "criterion";
type GuideStatus = "draft" | "approved";
type SelectionMode = "" | "top_n" | "minimum_score" | "both";
type ClarificationPolicy = "" | "allowed" | "not_allowed";

type GuideRule = {
  id: string;
  kind: RuleKind;
  title: string;
  statement: string;
  passingCondition: string;
  evidence: string;
  sourceNote: string;
  weight: number;
  anchor1: string;
  anchor3: string;
  anchor5: string;
};

type DecisionGuide = {
  schemaVersion: 1;
  version: number;
  basedOnVersion: number | null;
  status: GuideStatus;
  rules: GuideRule[];
  eligibilityConfirmedNone: boolean;
  eliminationConfirmedNone: boolean;
  selection: {
    mode: SelectionMode;
    shortlistTarget: string;
    minimumScore: string;
  };
  tieBreakPriority: string[];
  clarificationPolicy: ClarificationPolicy;
  missingInformationAcknowledged: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
};

type ApprovedSnapshot = {
  id: string;
  version: number;
  approvedAt: string;
  approvedBy: string;
  guide: DecisionGuide;
};

type StoredState = {
  schemaVersion: 3;
  details: CompetitionDetails;
  guide: DecisionGuide;
  approvedVersions: ApprovedSnapshot[];
  historicalImport: HistoricalImportSummary;
};

type ActiveView = "overview" | "details" | "guide" | "history";
type GuideSection = "entry" | "scoring" | "recommendation" | "approval";

type RuleEditorState = {
  mode: "add" | "edit";
  id: string | null;
  kind: RuleKind;
  title: string;
  statement: string;
  passingCondition: string;
  evidence: string;
  sourceNote: string;
  weight: string;
  anchor1: string;
  anchor3: string;
  anchor5: string;
};

type ValidationItem = {
  id: string;
  label: string;
  ok: boolean;
};

type SetupStep = {
  number: number;
  title: string;
  description: string;
  section: string;
};

const DEFAULT_DETAILS: CompetitionDetails = {
  competitionName: "Minder Net Zero",
  roundName: "",
  organiserName: "",
  shortlistTarget: "",
};

const SETUP_STEPS: SetupStep[] = [
  {
    number: 1,
    title: "Competition details",
    description: "Name this round and choose the shortlist target.",
    section: "Set up",
  },
  {
    number: 2,
    title: "Build your decision guide",
    description: "Define eligibility, selection and elimination rules.",
    section: "Set up",
  },
  {
    number: 3,
    title: "Upload past decisions",
    description: "Add previous applications and their outcomes.",
    section: "Teach",
  },
  {
    number: 4,
    title: "Teach Minder",
    description: "Review patterns Minder finds. Nothing is used without approval.",
    section: "Teach",
  },
  {
    number: 5,
    title: "Run a practice test",
    description: "Check recommendations against past decisions.",
    section: "Test",
  },
  {
    number: 6,
    title: "Confirm safeguards",
    description: "Approve how uncertainty and missing information are handled.",
    section: "Test",
  },
  {
    number: 7,
    title: "Upload current applications",
    description: "Import this year’s submissions and check the data.",
    section: "Assess",
  },
  {
    number: 8,
    title: "Assess and review",
    description: "Review evidence, confirm decisions and export results.",
    section: "Assess",
  },
];

const SAFETY_PROMISES = [
  { title: "No guessing", body: "Missing information is marked as not enough evidence." },
  { title: "Evidence for every score", body: "Recommendations point back to the applicant’s own words." },
  { title: "Uncertainty goes to people", body: "Borderline and unclear cases always enter human review." },
  { title: "People make final decisions", body: "Minder can recommend, but it cannot reject an application." },
];

const GUIDE_SECTIONS: Array<{ id: GuideSection; number: string; label: string }> = [
  { id: "entry", number: "1", label: "Entry rules" },
  { id: "scoring", number: "2", label: "Scoring guide" },
  { id: "recommendation", number: "3", label: "Recommendations" },
  { id: "approval", number: "4", label: "Review & approve" },
];

function makeId(prefix: string) {
  const suffix =
    typeof window !== "undefined" && window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function createEmptyGuide(shortlistTarget = ""): DecisionGuide {
  return {
    schemaVersion: 1,
    version: 1,
    basedOnVersion: null,
    status: "draft",
    rules: [],
    eligibilityConfirmedNone: false,
    eliminationConfirmedNone: false,
    selection: {
      mode: "",
      shortlistTarget,
      minimumScore: "",
    },
    tieBreakPriority: [],
    clarificationPolicy: "",
    missingInformationAcknowledged: false,
    approvedAt: null,
    approvedBy: null,
  };
}

function blankRuleEditor(kind: RuleKind): RuleEditorState {
  return {
    mode: "add",
    id: null,
    kind,
    title: "",
    statement: "",
    passingCondition: "",
    evidence: "",
    sourceNote: "",
    weight: "",
    anchor1: "",
    anchor3: "",
    anchor5: "",
  };
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function cleanPositiveInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? String(numeric) : "";
}

function sanitizeDetails(value: unknown): CompetitionDetails {
  const source = value && typeof value === "object" ? (value as Partial<CompetitionDetails>) : {};
  return {
    competitionName: cleanText(source.competitionName) || DEFAULT_DETAILS.competitionName,
    roundName: cleanText(source.roundName),
    organiserName: cleanText(source.organiserName),
    shortlistTarget: cleanPositiveInteger(source.shortlistTarget),
  };
}

function isRuleKind(value: unknown): value is RuleKind {
  return value === "eligibility" || value === "elimination" || value === "criterion";
}

function sanitizeRule(value: unknown): GuideRule | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<GuideRule>;
  if (!isRuleKind(source.kind)) return null;
  return {
    id: cleanText(source.id) || makeId("rule"),
    kind: source.kind,
    title: cleanText(source.title),
    statement: cleanText(source.statement),
    passingCondition: cleanText(source.passingCondition),
    evidence: cleanText(source.evidence),
    sourceNote: cleanText(source.sourceNote),
    weight: Number.isInteger(Number(source.weight)) ? Number(source.weight) : 0,
    anchor1: cleanText(source.anchor1),
    anchor3: cleanText(source.anchor3),
    anchor5: cleanText(source.anchor5),
  };
}

function sanitizeGuide(value: unknown, shortlistTarget: string): DecisionGuide {
  const empty = createEmptyGuide(shortlistTarget);
  if (!value || typeof value !== "object") return empty;
  const source = value as Partial<DecisionGuide>;
  const rawSelection =
    source.selection && typeof source.selection === "object" ? source.selection : empty.selection;
  const selectionMode: SelectionMode =
    rawSelection.mode === "top_n" ||
    rawSelection.mode === "minimum_score" ||
    rawSelection.mode === "both"
      ? rawSelection.mode
      : "";
  const rules = Array.isArray(source.rules)
    ? source.rules.map(sanitizeRule).filter((rule): rule is GuideRule => Boolean(rule))
    : [];
  const criterionIds = new Set(rules.filter((rule) => rule.kind === "criterion").map((rule) => rule.id));
  const tieBreakPriority = Array.isArray(source.tieBreakPriority)
    ? source.tieBreakPriority.filter(
        (id): id is string => typeof id === "string" && criterionIds.has(id),
      )
    : [];

  return {
    ...empty,
    version:
      Number.isInteger(Number(source.version)) && Number(source.version) > 0
        ? Number(source.version)
        : 1,
    basedOnVersion:
      Number.isInteger(Number(source.basedOnVersion)) && Number(source.basedOnVersion) > 0
        ? Number(source.basedOnVersion)
        : null,
    status: source.status === "approved" ? "approved" : "draft",
    rules,
    eligibilityConfirmedNone: source.eligibilityConfirmedNone === true,
    eliminationConfirmedNone: source.eliminationConfirmedNone === true,
    selection: {
      mode: selectionMode,
      shortlistTarget: cleanPositiveInteger(rawSelection.shortlistTarget) || shortlistTarget,
      minimumScore: cleanPositiveInteger(rawSelection.minimumScore),
    },
    tieBreakPriority,
    clarificationPolicy:
      source.clarificationPolicy === "allowed" || source.clarificationPolicy === "not_allowed"
        ? source.clarificationPolicy
        : "",
    missingInformationAcknowledged: source.missingInformationAcknowledged === true,
    approvedAt: cleanText(source.approvedAt) || null,
    approvedBy: cleanText(source.approvedBy) || null,
  };
}

function sanitizeSnapshots(value: unknown): ApprovedSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const source = item as Partial<ApprovedSnapshot>;
      const approvedAt = cleanText(source.approvedAt);
      const approvedBy = cleanText(source.approvedBy);
      const version = Number(source.version);
      if (!approvedAt || !approvedBy || !Number.isInteger(version) || version < 1) return null;
      const guide = sanitizeGuide(source.guide, "");
      return {
        id: cleanText(source.id) || `version-${version}`,
        version,
        approvedAt,
        approvedBy,
        guide: { ...guide, status: "approved", version, approvedAt, approvedBy },
      } satisfies ApprovedSnapshot;
    })
    .filter((snapshot): snapshot is ApprovedSnapshot => Boolean(snapshot));
}

function loadStoredState(): { state: StoredState; recovered: boolean } {
  if (typeof window === "undefined") {
    return {
      state: {
        schemaVersion: 3,
        details: DEFAULT_DETAILS,
        guide: createEmptyGuide(),
        approvedVersions: [],
        historicalImport: { ...EMPTY_HISTORICAL_IMPORT },
      },
      recovered: false,
    };
  }

  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) {
    try {
      const parsed = JSON.parse(current) as Partial<StoredState>;
      const details = sanitizeDetails(parsed.details);
      return {
        state: {
          schemaVersion: 3,
          details,
          guide: sanitizeGuide(parsed.guide, details.shortlistTarget),
          approvedVersions: sanitizeSnapshots(parsed.approvedVersions),
          historicalImport: sanitizeHistoricalImportSummary(parsed.historicalImport),
        },
        recovered: false,
      };
    } catch {
      // Fall through to the earlier safe draft instead of inventing replacement content.
    }
  }

  const phaseTwo = window.localStorage.getItem(V2_STORAGE_KEY);
  if (phaseTwo) {
    try {
      const parsed = JSON.parse(phaseTwo) as Partial<StoredState>;
      const details = sanitizeDetails(parsed.details);
      return {
        state: {
          schemaVersion: 3,
          details,
          guide: sanitizeGuide(parsed.guide, details.shortlistTarget),
          approvedVersions: sanitizeSnapshots(parsed.approvedVersions),
          historicalImport: { ...EMPTY_HISTORICAL_IMPORT },
        },
        recovered: Boolean(current),
      };
    } catch {
      // Continue to the Phase 1 setup details if they are still available.
    }
  }

  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    try {
      const details = sanitizeDetails(JSON.parse(legacy));
      return {
        state: {
          schemaVersion: 3,
          details,
          guide: createEmptyGuide(details.shortlistTarget),
          approvedVersions: [],
          historicalImport: { ...EMPTY_HISTORICAL_IMPORT },
        },
        recovered: Boolean(current || phaseTwo),
      };
    } catch {
      // Use a blank guide and clearly tell the user that recovery was needed.
    }
  }

  return {
    state: {
      schemaVersion: 3,
      details: DEFAULT_DETAILS,
      guide: createEmptyGuide(),
      approvedVersions: [],
      historicalImport: { ...EMPTY_HISTORICAL_IMPORT },
    },
    recovered: Boolean(current || phaseTwo || legacy),
  };
}

function trimmed(value: string) {
  return value.trim();
}

function rulesOfKind(guide: DecisionGuide, kind: RuleKind) {
  return guide.rules.filter((rule) => rule.kind === kind);
}

function getValidation(guide: DecisionGuide, details: CompetitionDetails): ValidationItem[] {
  const eligibility = rulesOfKind(guide, "eligibility");
  const elimination = rulesOfKind(guide, "elimination");
  const criteria = rulesOfKind(guide, "criterion");
  const criterionTitles = criteria.map((rule) => trimmed(rule.title).toLocaleLowerCase());
  const uniqueCriterionTitles = new Set(criterionTitles).size === criterionTitles.length;
  const weightsTotal = criteria.reduce((total, rule) => total + rule.weight, 0);
  const allRuleSourcesPresent = guide.rules.every((rule) => Boolean(trimmed(rule.sourceNote)));
  const eligibilityComplete = eligibility.every(
    (rule) =>
      Boolean(trimmed(rule.title)) &&
      Boolean(trimmed(rule.statement)) &&
      Boolean(trimmed(rule.passingCondition)) &&
      Boolean(trimmed(rule.evidence)),
  );
  const eliminationComplete = elimination.every(
    (rule) =>
      Boolean(trimmed(rule.title)) &&
      Boolean(trimmed(rule.statement)) &&
      Boolean(trimmed(rule.evidence)),
  );
  const criteriaComplete = criteria.every(
    (rule) =>
      Boolean(trimmed(rule.title)) &&
      Boolean(trimmed(rule.statement)) &&
      Boolean(trimmed(rule.evidence)) &&
      Number.isInteger(rule.weight) &&
      rule.weight > 0 &&
      rule.weight <= 100 &&
      Boolean(trimmed(rule.anchor1)) &&
      Boolean(trimmed(rule.anchor3)) &&
      Boolean(trimmed(rule.anchor5)),
  );
  const selectionTarget = Number(guide.selection.shortlistTarget);
  const minimumScore = Number(guide.selection.minimumScore);
  const selectionComplete =
    guide.selection.mode === "top_n"
      ? Number.isInteger(selectionTarget) && selectionTarget > 0
      : guide.selection.mode === "minimum_score"
        ? Number.isInteger(minimumScore) && minimumScore >= 1 && minimumScore <= 100
        : guide.selection.mode === "both"
          ? Number.isInteger(selectionTarget) &&
            selectionTarget > 0 &&
            Number.isInteger(minimumScore) &&
            minimumScore >= 1 &&
            minimumScore <= 100
          : false;
  const criterionIds = criteria.map((rule) => rule.id);
  const tieBreakComplete =
    criterionIds.length > 0 &&
    guide.tieBreakPriority.length === criterionIds.length &&
    new Set(guide.tieBreakPriority).size === criterionIds.length &&
    guide.tieBreakPriority.every((id) => criterionIds.includes(id));

  return [
    {
      id: "owner",
      label: "A named person owns final approval",
      ok: Boolean(trimmed(details.organiserName)),
    },
    {
      id: "eligibility",
      label: "Eligibility is defined or explicitly not required",
      ok:
        (eligibility.length > 0 && eligibilityComplete && !guide.eligibilityConfirmedNone) ||
        (eligibility.length === 0 && guide.eligibilityConfirmedNone),
    },
    {
      id: "criteria",
      label: "Every scoring criterion has evidence and score anchors",
      ok: criteria.length > 0 && criteriaComplete && uniqueCriterionTitles,
    },
    {
      id: "weights",
      label: `Scoring weights total 100% — currently ${weightsTotal}%`,
      ok: criteria.length > 0 && weightsTotal === 100,
    },
    {
      id: "selection",
      label: "The recommendation method is complete",
      ok: selectionComplete,
    },
    {
      id: "elimination",
      label: "Elimination is defined or explicitly not used",
      ok:
        (elimination.length > 0 && eliminationComplete && !guide.eliminationConfirmedNone) ||
        (elimination.length === 0 && guide.eliminationConfirmedNone),
    },
    {
      id: "sources",
      label: "Every rule records where it came from",
      ok: guide.rules.length > 0 && allRuleSourcesPresent,
    },
    {
      id: "ties",
      label: "Tie-break order is complete; people make the final call",
      ok: tieBreakComplete,
    },
    {
      id: "missing",
      label: "Missing-information safeguards are confirmed",
      ok:
        guide.missingInformationAcknowledged &&
        (guide.clarificationPolicy === "allowed" || guide.clarificationPolicy === "not_allowed"),
    },
  ];
}

function cloneGuide(guide: DecisionGuide): DecisionGuide {
  return JSON.parse(JSON.stringify(guide)) as DecisionGuide;
}

function formatApprovalDate(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function Home() {
  const [details, setDetails] = useState<CompetitionDetails>(DEFAULT_DETAILS);
  const [savedDetails, setSavedDetails] = useState<CompetitionDetails>(DEFAULT_DETAILS);
  const [guide, setGuide] = useState<DecisionGuide>(() => createEmptyGuide());
  const [approvedVersions, setApprovedVersions] = useState<ApprovedSnapshot[]>([]);
  const [historicalImport, setHistoricalImport] = useState<HistoricalImportSummary>({
    ...EMPTY_HISTORICAL_IMPORT,
  });
  const [historyStorageState, setHistoryStorageState] = useState<
    "unverified" | "verifying" | "verified" | "unavailable"
  >("unverified");
  const [isReady, setIsReady] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "error" | "recovered">("saved");
  const [activeView, setActiveView] = useState<ActiveView>("overview");

  useEffect(() => {
    const loaded = loadStoredState();
    // Hydration must finish before a device-local draft can safely replace the server default.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetails(loaded.state.details);
    setSavedDetails(loaded.state.details);
    setGuide(loaded.state.guide);
    setApprovedVersions(loaded.state.approvedVersions);
    setHistoricalImport(loaded.state.historicalImport);
    setSaveState(loaded.recovered ? "recovered" : "saved");
    setIsReady(true);
    setHistoryStorageState("verifying");
    void loadActiveHistoricalSummary()
      .then((activeSummary) => {
        if (activeSummary) {
          setHistoricalImport(activeSummary);
        } else if (loaded.state.historicalImport.status === "ready") {
          setHistoricalImport((current) => ({ ...current, status: "missing" }));
        }
        setHistoryStorageState("verified");
      })
      .catch(() => {
        setHistoricalImport((current) =>
          current.status === "ready" ? { ...current, status: "missing" } : current,
        );
        setHistoryStorageState("unavailable");
      });
  }, []);

  useEffect(() => {
    if (!isReady) return;
    const state: StoredState = {
      schemaVersion: 3,
      details: savedDetails,
      guide,
      approvedVersions,
      historicalImport,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      // This status reflects the result of synchronising with browser storage.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSavedAt(
        new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date()),
      );
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, [approvedVersions, guide, historicalImport, isReady, savedDetails]);

  const detailsComplete = useMemo(
    () =>
      Boolean(
        trimmed(savedDetails.competitionName) &&
          trimmed(savedDetails.organiserName) &&
          trimmed(savedDetails.shortlistTarget),
      ),
    [savedDetails],
  );
  const guideApproved =
    guide.status === "approved" &&
    Boolean(guide.approvedAt) &&
    getValidation(guide, savedDetails).every((item) => item.ok);
  const historyReady =
    guideApproved &&
    historyStorageState === "verified" &&
    historicalImport.status === "ready" &&
    Boolean(historicalImport.datasetId);
  const completedSteps =
    (detailsComplete ? 1 : 0) + (guideApproved ? 1 : 0) + (historyReady ? 1 : 0);
  const formComplete = Boolean(
    trimmed(details.competitionName) &&
      trimmed(details.organiserName) &&
      trimmed(details.shortlistTarget),
  );

  function saveCompetition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formComplete) return;
    const targetChanged =
      guide.status === "approved" && details.shortlistTarget !== savedDetails.shortlistTarget;
    if (
      targetChanged &&
      !window.confirm(
        "Changing the shortlist target affects the approved Decision Guide. Continue and create a new draft version?",
      )
    ) {
      return;
    }

    setSavedDetails(details);
    if (!guide.selection.shortlistTarget) {
      setGuide((current) => ({
        ...current,
        selection: { ...current.selection, shortlistTarget: details.shortlistTarget },
      }));
    } else if (targetChanged) {
      setGuide((current) => ({
        ...cloneGuide(current),
        version: current.version + 1,
        basedOnVersion: current.version,
        status: "draft",
        approvedAt: null,
        approvedBy: null,
        selection: { ...current.selection, shortlistTarget: details.shortlistTarget },
      }));
    }
    setActiveView("overview");
  }

  function openGuide() {
    if (!detailsComplete) return;
    if (!guide.selection.shortlistTarget && savedDetails.shortlistTarget) {
      setGuide((current) => ({
        ...current,
        selection: { ...current.selection, shortlistTarget: savedDetails.shortlistTarget },
      }));
    }
    setActiveView("guide");
  }

  function openHistory() {
    if (!guideApproved) return;
    setActiveView("history");
  }

  function updateHistoricalImport(summary: HistoricalImportSummary) {
    setHistoricalImport(summary);
    setHistoryStorageState("verified");
  }

  function approveGuide() {
    const validation = getValidation(guide, savedDetails);
    if (validation.some((item) => !item.ok) || !trimmed(savedDetails.organiserName)) return;
    const approvedAt = new Date().toISOString();
    const nextGuide: DecisionGuide = {
      ...cloneGuide(guide),
      status: "approved",
      approvedAt,
      approvedBy: savedDetails.organiserName.trim(),
    };
    const snapshot: ApprovedSnapshot = {
      id: makeId("guide-version"),
      version: nextGuide.version,
      approvedAt,
      approvedBy: savedDetails.organiserName.trim(),
      guide: cloneGuide(nextGuide),
    };
    setGuide(nextGuide);
    setApprovedVersions((versions) => [
      ...versions.filter((version) => version.version !== snapshot.version),
      snapshot,
    ]);
  }

  function createRevision() {
    if (guide.status !== "approved") return;
    if (
      !window.confirm(
        `Create Version ${guide.version + 1}? Version ${guide.version} will remain approved and unchanged until the new draft is approved.`,
      )
    ) {
      return;
    }
    setGuide({
      ...cloneGuide(guide),
      version: guide.version + 1,
      basedOnVersion: guide.version,
      status: "draft",
      approvedAt: null,
      approvedBy: null,
    });
  }

  function discardRevision() {
    if (!guide.basedOnVersion) return;
    const previous = approvedVersions.find((version) => version.version === guide.basedOnVersion);
    if (!previous) return;
    if (!window.confirm(`Discard this draft and return to approved Version ${previous.version}?`)) return;
    setGuide(cloneGuide(previous.guide));
  }

  const statusCopy =
    saveState === "error"
      ? "Could not save — keep this tab open"
      : saveState === "recovered"
        ? "Draft recovered — please review"
        : savedAt
          ? `Saved at ${savedAt}`
          : "Saved on this device";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">m<span /></div>
          <div>
            <div className="brand-name">Minder Net Zero</div>
            <div className="brand-subtitle">Application review</div>
          </div>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          <button className="nav-item nav-item-active" type="button" onClick={() => setActiveView("overview")}>
            <span className="nav-symbol" aria-hidden="true">01</span>Setup
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-symbol" aria-hidden="true">02</span>Applications
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-symbol" aria-hidden="true">03</span>Review
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-symbol" aria-hidden="true">04</span>Results
          </button>
        </nav>

        <div className="sidebar-safety">
          <div className="safety-lock" aria-hidden="true">✓</div>
          <div>
            <strong>Assessment is off</strong>
            <p>Minder cannot score applications until your rules and practice test are approved.</p>
          </div>
        </div>

        <div className="sidebar-footer"><span className="status-dot" />Private setup draft</div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <div className="eyebrow">Competition setup</div>
            <h1>{savedDetails.competitionName || "Minder Net Zero"}</h1>
          </div>
          <div
            className={`save-status ${saveState === "error" ? "save-status-error" : ""}`}
            role="status"
            aria-live="polite"
          >
            <span className="save-check">{saveState === "error" ? "!" : "✓"}</span>{statusCopy}
          </div>
        </header>

        <section className="safety-banner" aria-label="Minder safety policy">
          <div className="banner-icon" aria-hidden="true">◎</div>
          <div>
            <strong>Minder recommends. People decide.</strong>
            <p>Minder uses only your approved rules and the applicant’s own words. An authorised reviewer confirms every final decision.</p>
          </div>
          <span className="protection-badge">Protection active</span>
        </section>

        {activeView === "overview" ? (
          <Overview
            completedSteps={completedSteps}
            detailsComplete={detailsComplete}
            guideApproved={guideApproved}
            historyReady={historyReady}
            guideVersion={guide.version}
            isReady={isReady}
            onOpenDetails={() => setActiveView("details")}
            onOpenGuide={openGuide}
            onOpenHistory={openHistory}
          />
        ) : activeView === "details" ? (
          <CompetitionForm
            details={details}
            formComplete={formComplete}
            onChange={setDetails}
            onCancel={() => {
              setDetails(savedDetails);
              setActiveView("overview");
            }}
            onSubmit={saveCompetition}
          />
        ) : activeView === "guide" ? (
          <DecisionGuideBuilder
            key={`${guide.version}-${guide.status}`}
            details={savedDetails}
            guide={guide}
            approvedVersions={approvedVersions}
            onChange={setGuide}
            onApprove={approveGuide}
            onCreateRevision={createRevision}
            onDiscardRevision={discardRevision}
            onBack={() => setActiveView("overview")}
          />
        ) : (
          <HistoricalImportBuilder
            summary={historicalImport}
            guideVersion={guide.version}
            onSummaryChange={updateHistoricalImport}
            onBack={() => setActiveView("overview")}
          />
        )}
      </main>
    </div>
  );
}

function Overview({
  completedSteps,
  detailsComplete,
  guideApproved,
  historyReady,
  guideVersion,
  isReady,
  onOpenDetails,
  onOpenGuide,
  onOpenHistory,
}: {
  completedSteps: number;
  detailsComplete: boolean;
  guideApproved: boolean;
  historyReady: boolean;
  guideVersion: number;
  isReady: boolean;
  onOpenDetails: () => void;
  onOpenGuide: () => void;
  onOpenHistory: () => void;
}) {
  const nextTitle = !detailsComplete
    ? "Add competition details"
    : !guideApproved
      ? "Build your decision guide"
      : historyReady
        ? "Historical decisions are ready"
        : "Prepare historical decisions";
  const nextBody = !detailsComplete
    ? "Tell Minder who owns this competition and how many teams you plan to shortlist."
    : !guideApproved
      ? "Define the official rules Minder must follow before any historical patterns are considered."
      : historyReady
        ? "The sealed teaching and practice-test sets are stored separately. Step 4 remains locked in this phase."
        : `Decision Guide Version ${guideVersion} is approved. Historical data comes next.`;

  return (
    <div className="content-grid">
      <section className="setup-panel">
        <div className="setup-heading">
          <div>
            <span className="section-kicker">Your setup journey</span>
            <h2>Prepare a trustworthy assessment</h2>
            <p>Complete each step in order. Minder will never learn a rule or assess an application without your approval.</p>
          </div>
          <div className="progress-count"><strong>{completedSteps}</strong><span>of 8 complete</span></div>
        </div>

        <div className="progress-track" aria-label={`${completedSteps} of 8 steps complete`}>
          <span style={{ width: `${(completedSteps / 8) * 100}%` }} />
        </div>

        <div className="steps-list">
          {SETUP_STEPS.map((step) => {
            const complete =
              step.number === 1
                ? detailsComplete
                : step.number === 2
                  ? guideApproved
                  : step.number === 3
                    ? historyReady
                    : false;
            const available =
              step.number === 1 ||
              (step.number === 2 && detailsComplete) ||
              (step.number === 3 && guideApproved);
            const readyNext = step.number === 4 && historyReady;
            const action =
              step.number === 1 ? onOpenDetails : step.number === 2 ? onOpenGuide : onOpenHistory;
            return (
              <article
                className={`step-card ${available ? "step-available" : "step-locked"} ${complete ? "step-complete" : ""} ${readyNext ? "step-ready-next" : ""}`}
                key={step.number}
              >
                <div className="step-number" aria-hidden="true">{complete ? "✓" : String(step.number).padStart(2, "0")}</div>
                <div className="step-copy">
                  <div className="step-meta">{step.section}</div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
                <div className="step-action">
                  {available ? (
                    <button className="text-button" type="button" onClick={action}>
                      {complete
                        ? step.number === 2
                          ? `Review Version ${guideVersion}`
                          : step.number === 3
                            ? "Review import"
                            : "Review details"
                        : "Start here"}
                      <span aria-hidden="true">→</span>
                    </button>
                  ) : readyNext ? (
                    <span className="ready-label"><span aria-hidden="true">✓</span> Ready next</span>
                  ) : (
                    <span className="locked-label"><span aria-hidden="true">•</span> Locked</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <aside className="right-rail">
        <section className="rail-card accent-card">
          <div className="rail-label">Next action</div>
          <h2>{nextTitle}</h2>
          <p>{nextBody}</p>
          <button
            className="primary-button full-width"
            type="button"
            onClick={!detailsComplete ? onOpenDetails : !guideApproved ? onOpenGuide : onOpenHistory}
            disabled={!isReady || historyReady}
          >
            {!detailsComplete
              ? "Start setup"
              : !guideApproved
                ? "Build decision guide"
                : historyReady
                  ? "Phase complete"
                  : "Upload past decisions"}
          </button>
        </section>

        <section className="rail-card">
          <div className="rail-label">Before you begin</div>
          <ul className="simple-list">
            <li><span>1</span> Competition guidance and eligibility rules</li>
            <li><span>2</span> Past applications and final outcomes</li>
            <li><span>3</span> This year’s application export</li>
          </ul>
          <p className="small-note">You can leave and return at any time. Your progress is saved on this device.</p>
        </section>

        <section className="rail-card">
          <div className="rail-label">Trustworthy by design</div>
          <div className="promise-list">
            {SAFETY_PROMISES.map((promise) => (
              <div className="promise" key={promise.title}>
                <span className="promise-check" aria-hidden="true">✓</span>
                <div><strong>{promise.title}</strong><p>{promise.body}</p></div>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

function CompetitionForm({
  details,
  formComplete,
  onChange,
  onCancel,
  onSubmit,
}: {
  details: CompetitionDetails;
  formComplete: boolean;
  onChange: (details: CompetitionDetails) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="form-layout">
      <section className="form-card">
        <button className="back-button" type="button" onClick={onCancel}><span aria-hidden="true">←</span> Back to setup</button>
        <div className="form-heading">
          <div className="large-step-number">01</div>
          <div>
            <span className="section-kicker">Step 1 of 8</span>
            <h2>Competition details</h2>
            <p>This information helps your reviewers recognise the correct round and decision target.</p>
          </div>
        </div>

        <form onSubmit={onSubmit}>
          <div className="field-grid">
            <label className="field field-wide">
              <span>Competition name</span>
              <input value={details.competitionName} onChange={(event) => onChange({ ...details, competitionName: event.target.value })} placeholder="For example, Minder Net Zero" required />
            </label>
            <label className="field">
              <span>Round or year <small>Optional</small></span>
              <input value={details.roundName} onChange={(event) => onChange({ ...details, roundName: event.target.value })} placeholder="For example, 2026 cohort" />
            </label>
            <label className="field">
              <span>Target shortlist size</span>
              <input type="number" min="1" inputMode="numeric" value={details.shortlistTarget} onChange={(event) => onChange({ ...details, shortlistTarget: event.target.value })} placeholder="For example, 50" required />
            </label>
            <label className="field field-wide">
              <span>Person responsible for final approval</span>
              <input value={details.organiserName} onChange={(event) => onChange({ ...details, organiserName: event.target.value })} placeholder="Full name" required />
              <small>This person will approve the Decision Guide before assessments begin.</small>
            </label>
          </div>

          <div className="human-control">
            <span className="human-icon" aria-hidden="true">✓</span>
            <div><strong>Human approval is always required</strong><p>Minder cannot make a final shortlist or rejection on its own. This safeguard cannot be switched off.</p></div>
            <span className="always-on">Always on</span>
          </div>

          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
            <button className="primary-button" type="submit" disabled={!formComplete}>Save and continue</button>
          </div>
        </form>
      </section>

      <aside className="form-help">
        <div className="rail-label">Why this matters</div>
        <h3>A clear owner prevents silent AI decisions.</h3>
        <p>Minder records who approved each Decision Guide and who confirmed every final outcome.</p>
        <div className="help-divider" />
        <strong>Nothing is being assessed yet.</strong>
        <p>The assessment remains locked until the rule, history, test and safeguard steps are complete.</p>
      </aside>
    </div>
  );
}

function DecisionGuideBuilder({
  details,
  guide,
  approvedVersions,
  onChange,
  onApprove,
  onCreateRevision,
  onDiscardRevision,
  onBack,
}: {
  details: CompetitionDetails;
  guide: DecisionGuide;
  approvedVersions: ApprovedSnapshot[];
  onChange: (guide: DecisionGuide) => void;
  onApprove: () => void;
  onCreateRevision: () => void;
  onDiscardRevision: () => void;
  onBack: () => void;
}) {
  const [section, setSection] = useState<GuideSection>("entry");
  const [editor, setEditor] = useState<RuleEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);

  const validation = useMemo(() => getValidation(guide, details), [details, guide]);
  const fixes = validation.filter((item) => !item.ok);
  const allValid = fixes.length === 0;
  const criteria = rulesOfKind(guide, "criterion");
  const eligibility = rulesOfKind(guide, "eligibility");
  const elimination = rulesOfKind(guide, "elimination");
  const weightsTotal = criteria.reduce((total, rule) => total + rule.weight, 0);
  const isApproved =
    guide.status === "approved" &&
    Boolean(guide.approvedAt) &&
    validation.every((item) => item.ok);

  function changeSection(next: GuideSection) {
    setSection(next);
    setEditor(null);
    setEditorError(null);
  }

  function updateGuide(patch: Partial<DecisionGuide>) {
    if (isApproved) return;
    onChange({ ...guide, ...patch, approvedAt: null, approvedBy: null, status: "draft" });
  }

  function startAdd(kind: RuleKind) {
    if (isApproved) return;
    setEditor(blankRuleEditor(kind));
    setEditorError(null);
  }

  function startEdit(rule: GuideRule) {
    if (isApproved) return;
    setEditor({
      mode: "edit",
      id: rule.id,
      kind: rule.kind,
      title: rule.title,
      statement: rule.statement,
      passingCondition: rule.passingCondition,
      evidence: rule.evidence,
      sourceNote: rule.sourceNote,
      weight: rule.kind === "criterion" ? String(rule.weight || "") : "",
      anchor1: rule.anchor1,
      anchor3: rule.anchor3,
      anchor5: rule.anchor5,
    });
    setEditorError(null);
  }

  function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || isApproved) return;
    const required = [editor.title, editor.statement, editor.evidence, editor.sourceNote];
    if (editor.kind === "eligibility") required.push(editor.passingCondition);
    if (editor.kind === "criterion") required.push(editor.anchor1, editor.anchor3, editor.anchor5);
    if (required.some((value) => !trimmed(value))) {
      setEditorError("Complete every required field before saving this rule.");
      return;
    }
    const weight = editor.kind === "criterion" ? Number(editor.weight) : 0;
    if (editor.kind === "criterion" && (!Number.isInteger(weight) || weight < 1 || weight > 100)) {
      setEditorError("Enter a whole-number weight between 1% and 100%.");
      return;
    }
    const duplicateTitle = guide.rules.some(
      (rule) =>
        rule.kind === editor.kind &&
        rule.id !== editor.id &&
        trimmed(rule.title).toLocaleLowerCase() === trimmed(editor.title).toLocaleLowerCase(),
    );
    if (duplicateTitle) {
      setEditorError("Use a different name so reviewers can tell these rules apart.");
      return;
    }

    const rule: GuideRule = {
      id: editor.id ?? makeId("rule"),
      kind: editor.kind,
      title: trimmed(editor.title),
      statement: trimmed(editor.statement),
      passingCondition: trimmed(editor.passingCondition),
      evidence: trimmed(editor.evidence),
      sourceNote: trimmed(editor.sourceNote),
      weight,
      anchor1: trimmed(editor.anchor1),
      anchor3: trimmed(editor.anchor3),
      anchor5: trimmed(editor.anchor5),
    };
    const exists = guide.rules.some((item) => item.id === rule.id);
    const nextRules = exists
      ? guide.rules.map((item) => (item.id === rule.id ? rule : item))
      : [...guide.rules, rule];
    const nextPriority =
      rule.kind === "criterion" && !guide.tieBreakPriority.includes(rule.id)
        ? [...guide.tieBreakPriority, rule.id]
        : guide.tieBreakPriority;
    onChange({
      ...guide,
      status: "draft",
      rules: nextRules,
      tieBreakPriority: nextPriority,
      eligibilityConfirmedNone: rule.kind === "eligibility" ? false : guide.eligibilityConfirmedNone,
      eliminationConfirmedNone: rule.kind === "elimination" ? false : guide.eliminationConfirmedNone,
      approvedAt: null,
      approvedBy: null,
    });
    setEditor(null);
    setEditorError(null);
  }

  function deleteRule(rule: GuideRule) {
    if (isApproved) return;
    if (!window.confirm(`Remove “${rule.title}” from this draft?`)) return;
    onChange({
      ...guide,
      rules: guide.rules.filter((item) => item.id !== rule.id),
      tieBreakPriority: guide.tieBreakPriority.filter((id) => id !== rule.id),
      approvedAt: null,
      approvedBy: null,
      status: "draft",
    });
    if (editor?.id === rule.id) setEditor(null);
  }

  function makeWeightsEqual() {
    if (isApproved || criteria.length === 0) return;
    const base = Math.floor(100 / criteria.length);
    const remainder = 100 - base * criteria.length;
    let criterionIndex = 0;
    onChange({
      ...guide,
      rules: guide.rules.map((rule) => {
        if (rule.kind !== "criterion") return rule;
        const weight = base + (criterionIndex < remainder ? 1 : 0);
        criterionIndex += 1;
        return { ...rule, weight };
      }),
      status: "draft",
      approvedAt: null,
      approvedBy: null,
    });
  }

  function moveTieBreaker(id: string, direction: -1 | 1) {
    if (isApproved) return;
    const index = guide.tieBreakPriority.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= guide.tieBreakPriority.length) return;
    const next = [...guide.tieBreakPriority];
    [next[index], next[target]] = [next[target], next[index]];
    updateGuide({ tieBreakPriority: next });
  }

  function nextSection() {
    const index = GUIDE_SECTIONS.findIndex((item) => item.id === section);
    if (index < GUIDE_SECTIONS.length - 1) changeSection(GUIDE_SECTIONS[index + 1].id);
  }

  function previousSection() {
    const index = GUIDE_SECTIONS.findIndex((item) => item.id === section);
    if (index > 0) changeSection(GUIDE_SECTIONS[index - 1].id);
  }

  return (
    <div className="guide-layout">
      <section className="guide-card">
        <button className="back-button" type="button" onClick={onBack}><span aria-hidden="true">←</span> Back to setup</button>

        <div className="guide-heading">
          <div className="large-step-number">02</div>
          <div className="guide-heading-copy">
            <span className="section-kicker">Step 2 of 8</span>
            <h2>Build your Decision Guide</h2>
            <p>Tell Minder how your organisation decides. Use only approved competition policy.</p>
          </div>
          <div className={`guide-status ${isApproved ? "guide-status-approved" : ""}`}>
            <span>{isApproved ? "Approved" : guide.basedOnVersion ? "Changes need approval" : "Draft"}</span>
            <strong>Version {guide.version}</strong>
          </div>
        </div>

        <div className="rules-first-banner">
          <span aria-hidden="true">✓</span>
          <div><strong>Rules first, patterns later.</strong><p>Past decisions may help test this guide later, but they cannot silently become rules.</p></div>
        </div>

        {isApproved && (
          <div className="approved-banner">
            <div>
              <strong>Decision Guide Version {guide.version} is approved</strong>
              <p>Approved by {guide.approvedBy} on {formatApprovalDate(guide.approvedAt)}. This version is now read-only.</p>
            </div>
            <button className="secondary-button" type="button" onClick={onCreateRevision}>Create revised version</button>
          </div>
        )}

        {!isApproved && guide.basedOnVersion && (
          <div className="revision-banner">
            <div><strong>You are editing Version {guide.version}</strong><p>Approved Version {guide.basedOnVersion} remains unchanged until this draft is approved.</p></div>
            <button className="quiet-button" type="button" onClick={onDiscardRevision}>Discard draft</button>
          </div>
        )}

        <nav className="guide-tabs" aria-label="Decision Guide sections">
          {GUIDE_SECTIONS.map((item) => (
            <button
              type="button"
              className={section === item.id ? "guide-tab guide-tab-active" : "guide-tab"}
              onClick={() => changeSection(item.id)}
              aria-current={section === item.id ? "step" : undefined}
              key={item.id}
            >
              <span>{item.number}</span>{item.label}
            </button>
          ))}
        </nav>

        <div className="guide-section-content">
          {section === "entry" && (
            <EntryRulesSection
              guide={guide}
              eligibility={eligibility}
              elimination={elimination}
              editor={editor}
              editorError={editorError}
              isApproved={isApproved}
              onChange={onChange}
              onAdd={startAdd}
              onEdit={startEdit}
              onDelete={deleteRule}
              onEditorChange={setEditor}
              onEditorCancel={() => { setEditor(null); setEditorError(null); }}
              onEditorSubmit={saveRule}
            />
          )}

          {section === "scoring" && (
            <ScoringSection
              guide={guide}
              criteria={criteria}
              weightsTotal={weightsTotal}
              editor={editor}
              editorError={editorError}
              isApproved={isApproved}
              onAdd={() => startAdd("criterion")}
              onEdit={startEdit}
              onDelete={deleteRule}
              onMakeEqual={makeWeightsEqual}
              onEditorChange={setEditor}
              onEditorCancel={() => { setEditor(null); setEditorError(null); }}
              onEditorSubmit={saveRule}
            />
          )}

          {section === "recommendation" && (
            <RecommendationSection
              details={details}
              guide={guide}
              criteria={criteria}
              isApproved={isApproved}
              onChange={updateGuide}
              onMoveTieBreaker={moveTieBreaker}
            />
          )}

          {section === "approval" && (
            <ApprovalSection
              details={details}
              guide={guide}
              criteriaCount={criteria.length}
              eligibilityCount={eligibility.length}
              eliminationCount={elimination.length}
              weightsTotal={weightsTotal}
              validation={validation}
              allValid={allValid}
              approvalConfirmed={approvalConfirmed}
              isApproved={isApproved}
              approvedVersions={approvedVersions}
              onApprovalConfirmed={setApprovalConfirmed}
              onApprove={onApprove}
            />
          )}
        </div>

        <div className="guide-navigation">
          <button className="secondary-button" type="button" onClick={previousSection} disabled={section === "entry"}>Previous</button>
          {section !== "approval" && (
            <button className="primary-button" type="button" onClick={nextSection}>Save and continue</button>
          )}
        </div>
      </section>

      <aside className="guide-rail">
        <section className={`rail-card validation-card ${allValid ? "validation-card-ready" : ""}`}>
          <div className="rail-label">Guide check</div>
          <h3>{allValid ? "Ready to approve" : `${fixes.length} ${fixes.length === 1 ? "fix" : "fixes"} needed`}</h3>
          <p>{allValid ? "Every required part of the Decision Guide is complete." : "Complete these items before the guide can be approved."}</p>
          <div className="validation-list compact-validation">
            {validation.map((item) => (
              <div className={item.ok ? "validation-item validation-pass" : "validation-item"} key={item.id}>
                <span aria-hidden="true">{item.ok ? "✓" : "•"}</span><p>{item.label}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rail-card recipe-card">
          <div className="rail-label">Keep it clear</div>
          <h3>Think of this guide as a recipe.</h3>
          <p>If a new judge could not follow a rule consistently, Minder cannot apply it consistently.</p>
          <div className="clarity-example">
            <span>Too vague</span><p>“Strong team”</p>
          </div>
          <div className="clarity-example clarity-good">
            <span>Clearer</span><p>“Named delivery roles plus evidence of relevant work”</p>
          </div>
        </section>

        <section className="rail-card immutable-card">
          <div className="rail-label">Always protected</div>
          <p>Missing evidence, unclear eligibility, conflicting claims and unresolved ties always go to human review.</p>
        </section>
      </aside>
    </div>
  );
}

function EntryRulesSection({
  guide,
  eligibility,
  elimination,
  editor,
  editorError,
  isApproved,
  onChange,
  onAdd,
  onEdit,
  onDelete,
  onEditorChange,
  onEditorCancel,
  onEditorSubmit,
}: {
  guide: DecisionGuide;
  eligibility: GuideRule[];
  elimination: GuideRule[];
  editor: RuleEditorState | null;
  editorError: string | null;
  isApproved: boolean;
  onChange: (guide: DecisionGuide) => void;
  onAdd: (kind: RuleKind) => void;
  onEdit: (rule: GuideRule) => void;
  onDelete: (rule: GuideRule) => void;
  onEditorChange: (editor: RuleEditorState) => void;
  onEditorCancel: () => void;
  onEditorSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <SectionIntro eyebrow="Part 1" title="Entry rules" body="Define who may be considered and any clear reasons an application cannot progress. Add only rules that exist in approved competition policy." />

      <div className="rule-category-block">
        <div className="category-heading">
          <div><span className="category-tag eligibility-tag">Eligibility</span><h3>Who is allowed to be considered?</h3><p>Write each requirement so a reviewer can check it directly from the application.</p></div>
          {!isApproved && <button className="secondary-button compact-button" type="button" onClick={() => onAdd("eligibility")}>+ Add eligibility rule</button>}
        </div>
        {eligibility.length === 0 ? (
          <EmptyGuideState title="No eligibility rules added" body="Add every formal requirement, or explicitly confirm that there are no separate eligibility rules." />
        ) : (
          <RuleCards rules={eligibility} isApproved={isApproved} onEdit={onEdit} onDelete={onDelete} />
        )}
        <label className={`declaration-check ${eligibility.length > 0 ? "declaration-disabled" : ""}`}>
          <input
            type="checkbox"
            checked={guide.eligibilityConfirmedNone}
            disabled={isApproved || eligibility.length > 0}
            onChange={(event) => onChange({ ...guide, eligibilityConfirmedNone: event.target.checked, status: "draft", approvedAt: null, approvedBy: null })}
          />
          <span><strong>This competition has no separate eligibility rules</strong><small>Choose this only if the official policy confirms it.</small></span>
        </label>
        {editor?.kind === "eligibility" && (
          <RuleEditor editor={editor} error={editorError} onChange={onEditorChange} onCancel={onEditorCancel} onSubmit={onEditorSubmit} />
        )}
      </div>

      <div className="rule-category-block">
        <div className="category-heading">
          <div><span className="category-tag elimination-tag">Elimination</span><h3>Are there clear reasons an application cannot progress?</h3><p>These are explicit policy failures, not weak scores or subjective concerns.</p></div>
          {!isApproved && <button className="secondary-button compact-button" type="button" onClick={() => onAdd("elimination")}>+ Add elimination rule</button>}
        </div>
        {elimination.length === 0 ? (
          <EmptyGuideState title="No elimination rules added" body="Add formal reasons an application cannot progress, or confirm that scoring alone determines recommendations." />
        ) : (
          <RuleCards rules={elimination} isApproved={isApproved} onEdit={onEdit} onDelete={onDelete} />
        )}
        <label className={`declaration-check ${elimination.length > 0 ? "declaration-disabled" : ""}`}>
          <input
            type="checkbox"
            checked={guide.eliminationConfirmedNone}
            disabled={isApproved || elimination.length > 0}
            onChange={(event) => onChange({ ...guide, eliminationConfirmedNone: event.target.checked, status: "draft", approvedAt: null, approvedBy: null })}
          />
          <span><strong>This competition has no separate elimination rules</strong><small>Every application will be compared using the scoring guide.</small></span>
        </label>
        {editor?.kind === "elimination" && (
          <RuleEditor editor={editor} error={editorError} onChange={onEditorChange} onCancel={onEditorCancel} onSubmit={onEditorSubmit} />
        )}
      </div>

      <div className="fixed-safeguard"><span aria-hidden="true">✓</span><div><strong>A person confirms every outcome.</strong><p>Even when an elimination rule is clearly met, Minder can only recommend that the application does not progress.</p></div><span className="always-on">Always on</span></div>
    </>
  );
}

function ScoringSection({
  guide,
  criteria,
  weightsTotal,
  editor,
  editorError,
  isApproved,
  onAdd,
  onEdit,
  onDelete,
  onMakeEqual,
  onEditorChange,
  onEditorCancel,
  onEditorSubmit,
}: {
  guide: DecisionGuide;
  criteria: GuideRule[];
  weightsTotal: number;
  editor: RuleEditorState | null;
  editorError: string | null;
  isApproved: boolean;
  onAdd: () => void;
  onEdit: (rule: GuideRule) => void;
  onDelete: (rule: GuideRule) => void;
  onMakeEqual: () => void;
  onEditorChange: (editor: RuleEditorState) => void;
  onEditorCancel: () => void;
  onEditorSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const remaining = 100 - weightsTotal;
  return (
    <>
      <SectionIntro eyebrow="Part 2" title="Scoring guide" body="Define what strong applications demonstrate. Every criterion needs clear evidence and examples for low, expected and excellent scores." />

      <div className={`weight-summary ${weightsTotal === 100 ? "weight-summary-complete" : weightsTotal > 100 ? "weight-summary-over" : ""}`}>
        <div><span className="weight-total">{weightsTotal}%</span><div><strong>of the score assigned</strong><p>{weightsTotal === 100 ? "Weights are complete." : remaining > 0 ? `${remaining}% left to assign.` : `${Math.abs(remaining)}% must be removed.`}</p></div></div>
        <div className="weight-actions">
          {criteria.length > 1 && !isApproved && <button className="quiet-button" type="button" onClick={onMakeEqual}>Make weights equal</button>}
          {!isApproved && <button className="secondary-button compact-button" type="button" onClick={onAdd}>+ Add scoring criterion</button>}
        </div>
        <div className="weight-meter"><span style={{ width: `${Math.min(weightsTotal, 100)}%` }} /></div>
      </div>

      {criteria.length === 0 ? (
        <EmptyGuideState title="No scoring criteria yet" body="Add the official qualities judges use to compare eligible applications. Minder will not invent criteria." />
      ) : (
        <div className="criteria-list">
          {criteria.map((rule, index) => (
            <article className="criterion-card" key={rule.id}>
              <div className="criterion-topline"><span className="criterion-index">{String(index + 1).padStart(2, "0")}</span><div><h3>{rule.title}</h3><p>{rule.statement}</p></div><span className="criterion-weight">{rule.weight}%</span></div>
              <div className="criterion-evidence"><strong>Evidence required</strong><p>{rule.evidence}</p></div>
              <div className="anchor-grid">
                <div><span>1 · Weak or unsupported</span><p>{rule.anchor1}</p></div>
                <div><span>3 · Meets the standard</span><p>{rule.anchor3}</p></div>
                <div><span>5 · Excellent evidence</span><p>{rule.anchor5}</p></div>
              </div>
              <div className="rule-source"><span>Source</span>{rule.sourceNote}</div>
              {!isApproved && <div className="rule-card-actions"><button type="button" onClick={() => onEdit(rule)}>Edit</button><button className="danger-text" type="button" onClick={() => onDelete(rule)} aria-label={`Delete ${rule.title}`}>Remove</button></div>}
            </article>
          ))}
        </div>
      )}

      {editor?.kind === "criterion" && (
        <RuleEditor editor={editor} error={editorError} onChange={onEditorChange} onCancel={onEditorCancel} onSubmit={onEditorSubmit} />
      )}

      <div className="score-note"><strong>How scoring works</strong><p>Score 0 means the criterion was not addressed or has no relevant evidence. Scores 2 and 4 mean the evidence falls between the written anchors. Missing or conflicting evidence always goes to Human Review.</p></div>
      {guide.status === "approved" && <div className="read-only-note">This approved scoring guide is read-only. Create a revised version to make changes.</div>}
    </>
  );
}

function RecommendationSection({
  details,
  guide,
  criteria,
  isApproved,
  onChange,
  onMoveTieBreaker,
}: {
  details: CompetitionDetails;
  guide: DecisionGuide;
  criteria: GuideRule[];
  isApproved: boolean;
  onChange: (patch: Partial<DecisionGuide>) => void;
  onMoveTieBreaker: (id: string, direction: -1 | 1) => void;
}) {
  function updateSelection(patch: Partial<DecisionGuide["selection"]>) {
    onChange({ selection: { ...guide.selection, ...patch } });
  }

  return (
    <>
      <SectionIntro eyebrow="Part 3" title="Recommendation rules" body="Choose how scores become recommendations. These settings never turn an AI recommendation into a final decision." />

      <div className="recommendation-block">
        <h3>How should recommendations be made?</h3>
        <div className="selection-options">
          <label className={guide.selection.mode === "top_n" ? "selection-option selection-option-active" : "selection-option"}>
            <input type="radio" name="selection-mode" value="top_n" checked={guide.selection.mode === "top_n"} disabled={isApproved} onChange={() => updateSelection({ mode: "top_n", shortlistTarget: guide.selection.shortlistTarget || details.shortlistTarget })} />
            <span><strong>Recommend the strongest set number</strong><small>Rank eligible applications and recommend up to the shortlist target.</small></span>
          </label>
          <label className={guide.selection.mode === "minimum_score" ? "selection-option selection-option-active" : "selection-option"}>
            <input type="radio" name="selection-mode" value="minimum_score" checked={guide.selection.mode === "minimum_score"} disabled={isApproved} onChange={() => updateSelection({ mode: "minimum_score" })} />
            <span><strong>Recommend everyone above a minimum score</strong><small>Every eligible application meeting the threshold is recommended.</small></span>
          </label>
          <label className={guide.selection.mode === "both" ? "selection-option selection-option-active" : "selection-option"}>
            <input type="radio" name="selection-mode" value="both" checked={guide.selection.mode === "both"} disabled={isApproved} onChange={() => updateSelection({ mode: "both", shortlistTarget: guide.selection.shortlistTarget || details.shortlistTarget })} />
            <span><strong>Use both</strong><small>Recommend up to the target, but only when the minimum quality score is met.</small></span>
          </label>
        </div>

        {(guide.selection.mode === "top_n" || guide.selection.mode === "both") && (
          <label className="field recommendation-field"><span>Maximum teams to recommend</span><input type="number" min="1" inputMode="numeric" value={guide.selection.shortlistTarget} disabled={isApproved} onChange={(event) => updateSelection({ shortlistTarget: event.target.value })} placeholder="For example, 50" /></label>
        )}
        {(guide.selection.mode === "minimum_score" || guide.selection.mode === "both") && (
          <label className="field recommendation-field"><span>Minimum weighted score out of 100</span><input type="number" min="1" max="100" inputMode="numeric" value={guide.selection.minimumScore} disabled={isApproved} onChange={(event) => updateSelection({ minimumScore: event.target.value })} placeholder="For example, 70" /></label>
        )}
      </div>

      <div className="recommendation-block">
        <div className="category-heading"><div><h3>How should ties be handled?</h3><p>Put the most important scoring criterion first. If applications remain tied, they go to Human Review.</p></div></div>
        {criteria.length === 0 ? (
          <EmptyGuideState title="Add scoring criteria first" body="Tie-break priorities will appear here after criteria are added." />
        ) : (
          <ol className="tie-list">
            {guide.tieBreakPriority.map((id, index) => {
              const criterion = criteria.find((rule) => rule.id === id);
              if (!criterion) return null;
              return (
                <li key={id}>
                  <span className="tie-rank">{index + 1}</span><div><strong>{criterion.title}</strong><small>{index === 0 ? "Checked first" : "Checked if still tied"}</small></div>
                  {!isApproved && <div className="reorder-buttons"><button type="button" onClick={() => onMoveTieBreaker(id, -1)} disabled={index === 0} aria-label={`Move ${criterion.title} earlier`}>↑</button><button type="button" onClick={() => onMoveTieBreaker(id, 1)} disabled={index === guide.tieBreakPriority.length - 1} aria-label={`Move ${criterion.title} later`}>↓</button></div>}
                </li>
              );
            })}
          </ol>
        )}
        <div className="fixed-route"><span aria-hidden="true">→</span><div><strong>Still tied?</strong><p>Send every application at the shortlist boundary to Human Review.</p></div><span className="always-on">Always on</span></div>
      </div>

      <div className="recommendation-block">
        <h3>What happens when information is missing?</h3>
        <p className="block-intro">Minder never fills gaps with assumptions. Choose whether your organisers may request clarification.</p>
        <div className="selection-options compact-options">
          <label className={guide.clarificationPolicy === "allowed" ? "selection-option selection-option-active" : "selection-option"}>
            <input type="radio" name="clarification" checked={guide.clarificationPolicy === "allowed"} disabled={isApproved} onChange={() => onChange({ clarificationPolicy: "allowed" })} />
            <span><strong>Clarification may be requested</strong><small>Reviewers can ask the applicant for missing information.</small></span>
          </label>
          <label className={guide.clarificationPolicy === "not_allowed" ? "selection-option selection-option-active" : "selection-option"}>
            <input type="radio" name="clarification" checked={guide.clarificationPolicy === "not_allowed"} disabled={isApproved} onChange={() => onChange({ clarificationPolicy: "not_allowed" })} />
            <span><strong>Use submitted information only</strong><small>Missing information remains “Not enough evidence.”</small></span>
          </label>
        </div>
        <div className="immutable-routes">
          {["Missing evidence", "Unclear eligibility", "Conflicting claims", "Unclear elimination rule"].map((label) => (
            <div key={label}><span>✓</span><strong>{label}</strong><small>Human Review</small></div>
          ))}
        </div>
        <label className="declaration-check safeguard-confirmation">
          <input type="checkbox" checked={guide.missingInformationAcknowledged} disabled={isApproved} onChange={(event) => onChange({ missingInformationAcknowledged: event.target.checked })} />
          <span><strong>I confirm these safeguards</strong><small>Minder will not infer missing facts or automatically eliminate unclear applications.</small></span>
        </label>
      </div>
    </>
  );
}

function ApprovalSection({
  details,
  guide,
  criteriaCount,
  eligibilityCount,
  eliminationCount,
  weightsTotal,
  validation,
  allValid,
  approvalConfirmed,
  isApproved,
  approvedVersions,
  onApprovalConfirmed,
  onApprove,
}: {
  details: CompetitionDetails;
  guide: DecisionGuide;
  criteriaCount: number;
  eligibilityCount: number;
  eliminationCount: number;
  weightsTotal: number;
  validation: ValidationItem[];
  allValid: boolean;
  approvalConfirmed: boolean;
  isApproved: boolean;
  approvedVersions: ApprovedSnapshot[];
  onApprovalConfirmed: (checked: boolean) => void;
  onApprove: () => void;
}) {
  const selectionSummary =
    guide.selection.mode === "top_n"
      ? `recommends up to ${guide.selection.shortlistTarget || "—"} teams`
      : guide.selection.mode === "minimum_score"
        ? `recommends eligible applications scoring at least ${guide.selection.minimumScore || "—"}/100`
        : guide.selection.mode === "both"
          ? `recommends up to ${guide.selection.shortlistTarget || "—"} teams scoring at least ${guide.selection.minimumScore || "—"}/100`
          : "has no recommendation method yet";

  return (
    <>
      <SectionIntro eyebrow="Part 4" title="Review and approve" body="Read the summary, resolve every incomplete item and confirm that this guide reflects the official competition policy." />

      <div className="plain-summary">
        <div className="rail-label">Plain-language summary</div>
        <p>
          Minder checks <strong>{eligibilityCount || (guide.eligibilityConfirmedNone ? "no separate" : "—")}</strong> eligibility {eligibilityCount === 1 ? "rule" : "rules"}, scores <strong>{criteriaCount}</strong> {criteriaCount === 1 ? "criterion" : "criteria"} totalling <strong>{weightsTotal}%</strong>, and {selectionSummary}. It checks <strong>{eliminationCount || (guide.eliminationConfirmedNone ? "no separate" : "—")}</strong> elimination {eliminationCount === 1 ? "rule" : "rules"}. Missing, conflicting and tied cases go to <strong>Human Review</strong>. Nothing is rejected automatically.
        </p>
      </div>

      <div className="approval-checklist">
        <h3>Approval checklist</h3>
        <div className="validation-list">
          {validation.map((item) => (
            <div className={item.ok ? "validation-item validation-pass" : "validation-item"} key={item.id}>
              <span aria-hidden="true">{item.ok ? "✓" : "!"}</span><p>{item.label}</p>
            </div>
          ))}
        </div>
      </div>

      {isApproved ? (
        <div className="approval-complete">
          <span className="approval-seal" aria-hidden="true">✓</span>
          <div><div className="rail-label">Approved Version {guide.version}</div><h3>This guide is ready for historical testing</h3><p>{guide.approvedBy} approved this version on {formatApprovalDate(guide.approvedAt)}. Step 3 is now ready.</p></div>
        </div>
      ) : (
        <div className={`final-approval-card ${allValid ? "final-approval-ready" : ""}`}>
          <div>
            <div className="rail-label">Final human approval</div>
            <h3>{allValid ? `Ready for ${details.organiserName} to approve` : "Complete the guide before approval"}</h3>
            <p>Approval creates a read-only Version {guide.version}. Future changes will require a new version.</p>
          </div>
          <label className="approval-confirmation">
            <input type="checkbox" checked={approvalConfirmed} disabled={!allValid} onChange={(event) => onApprovalConfirmed(event.target.checked)} />
            <span>I confirm this Decision Guide reflects the approved competition policy and that people remain responsible for final decisions.</span>
          </label>
          <button className="primary-button full-width" type="button" disabled={!allValid || !approvalConfirmed} onClick={onApprove}>Approve Decision Guide Version {guide.version}</button>
        </div>
      )}

      {approvedVersions.length > 0 && (
        <div className="version-history-preview">
          <div className="rail-label">Approved history</div>
          {[...approvedVersions].sort((a, b) => b.version - a.version).map((snapshot) => (
            <div key={snapshot.id}><strong>Version {snapshot.version}</strong><span>{snapshot.approvedBy} · {formatApprovalDate(snapshot.approvedAt)}</span></div>
          ))}
        </div>
      )}
    </>
  );
}

function SectionIntro({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return <div className="section-intro"><span className="section-kicker">{eyebrow}</span><h3>{title}</h3><p>{body}</p></div>;
}

function EmptyGuideState({ title, body }: { title: string; body: string }) {
  return <div className="guide-empty-state"><span aria-hidden="true">＋</span><div><strong>{title}</strong><p>{body}</p></div></div>;
}

function RuleCards({
  rules,
  isApproved,
  onEdit,
  onDelete,
}: {
  rules: GuideRule[];
  isApproved: boolean;
  onEdit: (rule: GuideRule) => void;
  onDelete: (rule: GuideRule) => void;
}) {
  return (
    <div className="rule-cards">
      {rules.map((rule, index) => (
        <article className="rule-card" key={rule.id}>
          <div className="rule-order">{String(index + 1).padStart(2, "0")}</div>
          <div className="rule-card-copy">
            <h4>{rule.title}</h4><p>{rule.statement}</p>
            {rule.kind === "eligibility" && <div className="rule-detail"><span>Passing means</span>{rule.passingCondition}</div>}
            <div className="rule-detail"><span>Evidence required</span>{rule.evidence}</div>
            <div className="rule-source"><span>Source</span>{rule.sourceNote}</div>
          </div>
          {!isApproved && <div className="rule-card-actions"><button type="button" onClick={() => onEdit(rule)}>Edit</button><button className="danger-text" type="button" onClick={() => onDelete(rule)} aria-label={`Delete ${rule.title}`}>Remove</button></div>}
        </article>
      ))}
    </div>
  );
}

function RuleEditor({
  editor,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  editor: RuleEditorState;
  error: string | null;
  onChange: (editor: RuleEditorState) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const isCriterion = editor.kind === "criterion";
  const title = isCriterion
    ? editor.mode === "add" ? "Add scoring criterion" : "Edit scoring criterion"
    : editor.kind === "eligibility"
      ? editor.mode === "add" ? "Add eligibility rule" : "Edit eligibility rule"
      : editor.mode === "add" ? "Add elimination rule" : "Edit elimination rule";
  const statementLabel = isCriterion
    ? "What should judges look for?"
    : editor.kind === "eligibility"
      ? "Applicants must…"
      : "Recommend not progressing when…";

  return (
    <form className="rule-editor" onSubmit={onSubmit}>
      <div className="editor-heading"><div><div className="rail-label">{editor.mode === "add" ? "New" : "Editing"}</div><h3>{title}</h3></div><button className="quiet-button" type="button" onClick={onCancel}>Cancel</button></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="editor-grid">
        <label className="field field-wide"><span>Short name</span><input autoFocus value={editor.title} onChange={(event) => onChange({ ...editor, title: event.target.value })} placeholder={isCriterion ? "For example, a criterion from your official guide" : "Use the official rule name"} required /></label>
        <label className="field field-wide"><span>{statementLabel}</span><textarea value={editor.statement} onChange={(event) => onChange({ ...editor, statement: event.target.value })} placeholder="Write this in plain language using the official policy" required /></label>
        {editor.kind === "eligibility" && <label className="field field-wide"><span>What counts as meeting this rule?</span><textarea value={editor.passingCondition} onChange={(event) => onChange({ ...editor, passingCondition: event.target.value })} placeholder="Describe the clear passing condition" required /></label>}
        <label className="field field-wide"><span>What information proves this?</span><textarea value={editor.evidence} onChange={(event) => onChange({ ...editor, evidence: event.target.value })} placeholder="Name the application answer or evidence reviewers should check" required /></label>
        {isCriterion && (
          <>
            <label className="field editor-weight"><span>Weight</span><div className="number-suffix"><input type="number" min="1" max="100" inputMode="numeric" value={editor.weight} onChange={(event) => onChange({ ...editor, weight: event.target.value })} required /><span>%</span></div></label>
            <div className="anchor-editor field-wide">
              <div><label className="field"><span>Score 1 · Weak or unsupported</span><textarea value={editor.anchor1} onChange={(event) => onChange({ ...editor, anchor1: event.target.value })} placeholder="Describe weak or unsupported evidence" required /></label></div>
              <div><label className="field"><span>Score 3 · Meets the standard</span><textarea value={editor.anchor3} onChange={(event) => onChange({ ...editor, anchor3: event.target.value })} placeholder="Describe evidence that meets the standard" required /></label></div>
              <div><label className="field"><span>Score 5 · Excellent evidence</span><textarea value={editor.anchor5} onChange={(event) => onChange({ ...editor, anchor5: event.target.value })} placeholder="Describe excellent, specific evidence" required /></label></div>
            </div>
          </>
        )}
        <label className="field field-wide"><span>Where does this rule come from?</span><input value={editor.sourceNote} onChange={(event) => onChange({ ...editor, sourceNote: event.target.value })} placeholder="For example, Official guidance, section 3" required /><small>This helps reviewers trace the rule back to approved policy.</small></label>
      </div>
      <div className="editor-safety"><span>✓</span><p>{editor.kind === "elimination" ? "A matching rule can only recommend not progressing. A person must confirm the outcome." : "If evidence is missing or unclear, the application goes to Human Review."}</p></div>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit">{editor.mode === "add" ? "Add to guide" : "Save changes"}</button></div>
    </form>
  );
}
