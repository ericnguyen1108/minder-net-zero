"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  emptyDecisionGuide,
  type DecisionGuideContent,
} from "../../lib/decision-guide.ts";
import { platformFetch } from "../platform-client.ts";

type GuideSnapshot = {
  id: string;
  version: number;
  status: "draft" | "approved" | "retired";
  title: string;
  guide: DecisionGuideContent;
  createdAt: string;
  approvedAt: string | null;
};
type GuideState = {
  competitionId: string;
  latestVersion: number;
  latest: GuideSnapshot | null;
  approved: GuideSnapshot | null;
  history: Array<Omit<GuideSnapshot, "guide">>;
};
type Competition = { id: string; name: string; permissions: string[] };
type GuideResponse = { competitions: Competition[]; guides: GuideState[] };

function cloneGuide(guide: DecisionGuideContent): DecisionGuideContent {
  return structuredClone(guide);
}

function newRule(kind: "eligibility" | "elimination" | "criterion") {
  return {
    id: crypto.randomUUID(),
    kind,
    title: "",
    statement: "",
    passingCondition: "",
    evidence: "",
    sourceNote: "",
    weight: 0,
    anchor1: "",
    anchor3: "",
    anchor5: "",
  } as DecisionGuideContent["rules"][number];
}

export default function GuideManager() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [states, setStates] = useState<GuideState[]>([]);
  const [competitionId, setCompetitionId] = useState("");
  const [title, setTitle] = useState("Competition Decision Guide");
  const [guide, setGuide] = useState<DecisionGuideContent>(() => emptyDecisionGuide());
  const [baseVersion, setBaseVersion] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [message, setMessage] = useState("");

  const competition = competitions.find((item) => item.id === competitionId) ?? null;
  const guideState = states.find((item) => item.competitionId === competitionId) ?? null;
  const mayWrite = competition?.permissions.includes("rubric.write") ?? false;
  const mayApprove = competition?.permissions.includes("rubric.approve") ?? false;

  const applyState = useCallback((next: GuideState, force = false) => {
    if (!force && next.latestVersion === baseVersion) return;
    setBaseVersion(next.latestVersion);
    if (next.latest) {
      setGuide(cloneGuide(next.latest.guide));
      setTitle(next.latest.title);
    } else {
      setGuide(emptyDecisionGuide());
      setTitle("Competition Decision Guide");
    }
  }, [baseVersion]);

  const load = useCallback(async (force = false) => {
    try {
      const body = await platformFetch<GuideResponse>("/api/platform/guides");
      setCompetitions(body.competitions);
      setStates(body.guides);
      const selected = competitionId || body.competitions[0]?.id || "";
      setCompetitionId(selected);
      const selectedState = body.guides.find((item) => item.competitionId === selected);
      if (selectedState) applyState(selectedState, force);
      setState("ready");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The Decision Guide could not be loaded.");
    }
  }, [applyState, competitionId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(true), 0);
    return () => window.clearTimeout(initial);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function selectCompetition(id: string) {
    setCompetitionId(id);
    const selected = states.find((item) => item.competitionId === id);
    if (selected) applyState(selected, true);
    setMessage("");
  }

  function updateRule(id: string, patch: Partial<DecisionGuideContent["rules"][number]>) {
    setGuide((current) => ({
      ...current,
      rules: current.rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule),
    }));
  }

  function addRule(kind: "eligibility" | "elimination" | "criterion") {
    setGuide((current) => ({ ...current, rules: [...current.rules, newRule(kind)] }));
  }

  function removeRule(id: string) {
    setGuide((current) => ({
      ...current,
      rules: current.rules.filter((rule) => rule.id !== id),
      tieBreakPriority: current.tieBreakPriority.filter((ruleId) => ruleId !== id),
    }));
  }

  function toggleTieBreak(id: string) {
    setGuide((current) => ({
      ...current,
      tieBreakPriority: current.tieBreakPriority.includes(id)
        ? current.tieBreakPriority.filter((item) => item !== id)
        : [...current.tieBreakPriority, id],
    }));
  }

  async function save(action: "save" | "approve") {
    if (!competitionId || state === "saving") return;
    if (action === "approve" && !window.confirm("Approve this exact Decision Guide version? It will become immutable and available to assessment workflows.")) return;
    setState("saving");
    setMessage("");
    try {
      const body = await platformFetch<{ snapshot: GuideSnapshot; state: GuideState }>("/api/platform/guides", {
        method: "POST",
        body: JSON.stringify({ competitionId, action, expectedLatestVersion: baseVersion, title, guide }),
      });
      setStates((current) => [...current.filter((item) => item.competitionId !== competitionId), body.state]);
      applyState(body.state, true);
      setState("ready");
      setMessage(action === "approve" ? `Version ${body.snapshot.version} approved and locked.` : `Draft snapshot ${body.snapshot.version} saved centrally.`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The Decision Guide could not be saved.");
    }
  }

  const criterionWeight = useMemo(
    () => guide.rules.filter((rule) => rule.kind === "criterion").reduce((sum, rule) => sum + rule.weight, 0),
    [guide.rules],
  );

  if (state === "loading") return <section className="platform-card dashboard-loading">Loading the central Decision Guide…</section>;
  if (!competition) return <section className="platform-card dashboard-loading"><p className="platform-error">{message || "No competition is assigned to this account."}</p></section>;

  return (
    <div className="guide-workspace">
      <section className="platform-card guide-toolbar">
        <label>Competition<select value={competitionId} onChange={(event) => selectCompetition(event.target.value)}>{competitions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Guide title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} disabled={!mayWrite} /></label>
        <div className="guide-version-state"><span>Latest snapshot</span><strong>{guideState?.latestVersion ? `Version ${guideState.latestVersion}` : "Not saved"}</strong><small>{guideState?.approved ? `Approved: v${guideState.approved.version}` : "No approved version"}</small></div>
        <button className="platform-secondary" type="button" onClick={() => void load(true)}>Load latest</button>
      </section>

      <section className="platform-card guide-section">
        <div className="platform-card-heading"><div><p className="eyebrow">Step 1</p><h2>Eligibility and elimination rules</h2></div><span>Evidence only</span></div>
        <p className="guide-help">Use a rule only when it can be checked from the submitted application. Missing information must go to human review, never be guessed.</p>
        <div className="guide-rule-list">
          {guide.rules.filter((rule) => rule.kind !== "criterion").map((rule) => (
            <RuleEditor key={rule.id} rule={rule} disabled={!mayWrite} onChange={(patch) => updateRule(rule.id, patch)} onRemove={() => removeRule(rule.id)} />
          ))}
        </div>
        <div className="guide-add-row"><button type="button" onClick={() => addRule("eligibility")} disabled={!mayWrite}>+ Eligibility rule</button><button type="button" onClick={() => addRule("elimination")} disabled={!mayWrite}>+ Elimination rule</button></div>
        <div className="guide-confirm-grid">
          <label><input type="checkbox" checked={guide.eligibilityConfirmedNone} onChange={(event) => setGuide((current) => ({ ...current, eligibilityConfirmedNone: event.target.checked }))} disabled={!mayWrite} />There are no other eligibility rules</label>
          <label><input type="checkbox" checked={guide.eliminationConfirmedNone} onChange={(event) => setGuide((current) => ({ ...current, eliminationConfirmedNone: event.target.checked }))} disabled={!mayWrite} />There are no other elimination rules</label>
        </div>
      </section>

      <section className="platform-card guide-section">
        <div className="platform-card-heading"><div><p className="eyebrow">Step 2</p><h2>Scoring criteria</h2></div><span className={criterionWeight === 100 ? "weight-ok" : "weight-warning"}>{criterionWeight}/100 weight</span></div>
        <p className="guide-help">Each criterion needs clear evidence and examples of weak, adequate and excellent responses.</p>
        <div className="guide-rule-list">
          {guide.rules.filter((rule) => rule.kind === "criterion").map((rule) => (
            <RuleEditor key={rule.id} rule={rule} disabled={!mayWrite} onChange={(patch) => updateRule(rule.id, patch)} onRemove={() => removeRule(rule.id)} />
          ))}
        </div>
        <div className="guide-add-row"><button type="button" onClick={() => addRule("criterion")} disabled={!mayWrite}>+ Scoring criterion</button></div>
      </section>

      <section className="platform-card guide-section">
        <div className="platform-card-heading"><div><p className="eyebrow">Step 3</p><h2>Selection and uncertainty</h2></div><span>People decide</span></div>
        <div className="guide-selection-grid">
          <label>Selection method<select value={guide.selection.mode} onChange={(event) => setGuide((current) => ({ ...current, selection: { ...current.selection, mode: event.target.value as DecisionGuideContent["selection"]["mode"] } }))} disabled={!mayWrite}><option value="top_n">Top number of teams</option><option value="minimum_score">Minimum score</option><option value="both">Both rules</option></select></label>
          <label>Shortlist size<input inputMode="numeric" value={guide.selection.shortlistTarget} onChange={(event) => setGuide((current) => ({ ...current, selection: { ...current.selection, shortlistTarget: event.target.value } }))} disabled={!mayWrite} /></label>
          <label>Minimum weighted score (0–100)<input inputMode="decimal" value={guide.selection.minimumScore} onChange={(event) => setGuide((current) => ({ ...current, selection: { ...current.selection, minimumScore: event.target.value } }))} disabled={!mayWrite} /></label>
          <label>Clarifications<select value={guide.clarificationPolicy} onChange={(event) => setGuide((current) => ({ ...current, clarificationPolicy: event.target.value as DecisionGuideContent["clarificationPolicy"] }))} disabled={!mayWrite}><option value="not_allowed">Not allowed during assessment</option><option value="allowed">Allowed through organiser</option></select></label>
        </div>
        <fieldset className="guide-tiebreak"><legend>Tie-break priorities</legend>{guide.rules.filter((rule) => rule.kind === "criterion").map((rule) => <label key={rule.id}><input type="checkbox" checked={guide.tieBreakPriority.includes(rule.id)} onChange={() => toggleTieBreak(rule.id)} disabled={!mayWrite} />{rule.title || "Untitled criterion"}</label>)}</fieldset>
        <label className="guide-missing-confirm"><input type="checkbox" checked={guide.missingInformationAcknowledged} onChange={(event) => setGuide((current) => ({ ...current, missingInformationAcknowledged: event.target.checked as true }))} disabled={!mayWrite} />I understand that missing or conflicting evidence must be sent to human review and cannot be guessed by AI.</label>
      </section>

      <section className="platform-card guide-approval-bar">
        <div><strong>Minder cannot assess from an unapproved guide.</strong><p>Saving creates a central snapshot. Approval creates a new immutable version with your signed-in identity.</p></div>
        <div><button className="platform-secondary" type="button" onClick={() => void save("save")} disabled={!mayWrite || state === "saving"}>{state === "saving" ? "Saving…" : "Save draft snapshot"}</button><button className="platform-primary" type="button" onClick={() => void save("approve")} disabled={!mayApprove || state === "saving"}>Approve and lock</button></div>
        {message ? <p className={state === "error" ? "platform-error" : "platform-success"} role="status">{message}</p> : null}
      </section>
    </div>
  );
}

function RuleEditor({
  rule,
  disabled,
  onChange,
  onRemove,
}: {
  rule: DecisionGuideContent["rules"][number];
  disabled: boolean;
  onChange: (patch: Partial<DecisionGuideContent["rules"][number]>) => void;
  onRemove: () => void;
}) {
  return (
    <article className="guide-rule-card">
      <div className="guide-rule-heading"><span>{rule.kind.replaceAll("_", " ")}</span><button type="button" onClick={onRemove} disabled={disabled}>Remove</button></div>
      <div className="guide-rule-grid">
        <label>Rule name<input value={rule.title} onChange={(event) => onChange({ title: event.target.value })} disabled={disabled} /></label>
        {rule.kind === "criterion" ? <label>Weight<input type="number" min="0" max="100" value={rule.weight} onChange={(event) => onChange({ weight: Number(event.target.value) })} disabled={disabled} /></label> : null}
        <label className="wide">What should be assessed?<textarea value={rule.statement} onChange={(event) => onChange({ statement: event.target.value })} disabled={disabled} /></label>
        <label>Passing condition<textarea value={rule.passingCondition} onChange={(event) => onChange({ passingCondition: event.target.value })} disabled={disabled} /></label>
        <label>Acceptable evidence<textarea value={rule.evidence} onChange={(event) => onChange({ evidence: event.target.value })} disabled={disabled} /></label>
        {rule.kind === "criterion" ? <><label>Score 1 — weak<textarea value={rule.anchor1} onChange={(event) => onChange({ anchor1: event.target.value })} disabled={disabled} /></label><label>Score 3 — adequate<textarea value={rule.anchor3} onChange={(event) => onChange({ anchor3: event.target.value })} disabled={disabled} /></label><label>Score 5 — excellent<textarea value={rule.anchor5} onChange={(event) => onChange({ anchor5: event.target.value })} disabled={disabled} /></label></> : null}
        <label className="wide">Source or organiser note (not shown to AI as applicant evidence)<textarea value={rule.sourceNote} onChange={(event) => onChange({ sourceNote: event.target.value })} disabled={disabled} /></label>
      </div>
    </article>
  );
}
