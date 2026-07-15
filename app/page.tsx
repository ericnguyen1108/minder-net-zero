"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "minder-net-zero-phase-1";

type CompetitionDetails = {
  competitionName: string;
  roundName: string;
  organiserName: string;
  shortlistTarget: string;
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
  {
    title: "No guessing",
    body: "Missing information is marked as not enough evidence.",
  },
  {
    title: "Evidence for every score",
    body: "Recommendations point back to the applicant’s own words.",
  },
  {
    title: "Uncertainty goes to people",
    body: "Borderline and unclear cases always enter human review.",
  },
  {
    title: "People make final decisions",
    body: "Minder can recommend, but it cannot reject an application.",
  },
];

function loadDetails(): CompetitionDetails {
  if (typeof window === "undefined") return DEFAULT_DETAILS;

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_DETAILS;
    const parsed = JSON.parse(saved) as Partial<CompetitionDetails>;
    return { ...DEFAULT_DETAILS, ...parsed };
  } catch {
    return DEFAULT_DETAILS;
  }
}

export default function Home() {
  const [details, setDetails] = useState<CompetitionDetails>(DEFAULT_DETAILS);
  const [savedDetails, setSavedDetails] = useState<CompetitionDetails>(DEFAULT_DETAILS);
  const [isReady, setIsReady] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"overview" | "details">("overview");

  useEffect(() => {
    const stored = loadDetails();
    setDetails(stored);
    setSavedDetails(stored);
    setIsReady(true);
  }, []);

  const detailsComplete = useMemo(
    () =>
      Boolean(
        savedDetails.competitionName.trim() &&
          savedDetails.organiserName.trim() &&
          savedDetails.shortlistTarget.trim(),
      ),
    [savedDetails],
  );

  const completedSteps = detailsComplete ? 1 : 0;
  const formComplete = Boolean(
    details.competitionName.trim() &&
      details.organiserName.trim() &&
      details.shortlistTarget.trim(),
  );

  function saveCompetition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formComplete) return;

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(details));
    setSavedDetails(details);
    setSavedAt(
      new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date()),
    );
    setActiveView("overview");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            m
            <span />
          </div>
          <div>
            <div className="brand-name">Minder Net Zero</div>
            <div className="brand-subtitle">Application review</div>
          </div>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          <button className="nav-item nav-item-active" type="button">
            <span className="nav-symbol" aria-hidden="true">01</span>
            Setup
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-symbol" aria-hidden="true">02</span>
            Applications
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-symbol" aria-hidden="true">03</span>
            Review
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-symbol" aria-hidden="true">04</span>
            Results
          </button>
        </nav>

        <div className="sidebar-safety">
          <div className="safety-lock" aria-hidden="true">✓</div>
          <div>
            <strong>Assessment is off</strong>
            <p>Minder cannot score applications until your rules and practice test are approved.</p>
          </div>
        </div>

        <div className="sidebar-footer">
          <span className="status-dot" />
          Private setup draft
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <div className="eyebrow">Competition setup</div>
            <h1>{savedDetails.competitionName || "Minder Net Zero"}</h1>
          </div>
          <div className="save-status" role="status" aria-live="polite">
            <span className="save-check">✓</span>
            {savedAt ? `Saved at ${savedAt}` : "Saved on this device"}
          </div>
        </header>

        <section className="safety-banner" aria-label="Minder safety policy">
          <div className="banner-icon" aria-hidden="true">◎</div>
          <div>
            <strong>Minder recommends. People decide.</strong>
            <p>
              Minder uses only your approved rules and the applicant’s own words. An authorised
              reviewer confirms every final decision.
            </p>
          </div>
          <span className="protection-badge">Protection active</span>
        </section>

        {activeView === "overview" ? (
          <Overview
            completedSteps={completedSteps}
            detailsComplete={detailsComplete}
            isReady={isReady}
            onStart={() => setActiveView("details")}
          />
        ) : (
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
        )}
      </main>
    </div>
  );
}

function Overview({
  completedSteps,
  detailsComplete,
  isReady,
  onStart,
}: {
  completedSteps: number;
  detailsComplete: boolean;
  isReady: boolean;
  onStart: () => void;
}) {
  return (
    <div className="content-grid">
      <section className="setup-panel">
        <div className="setup-heading">
          <div>
            <span className="section-kicker">Your setup journey</span>
            <h2>Prepare a trustworthy assessment</h2>
            <p>
              Complete each step in order. Minder will never learn a rule or assess an
              application without your approval.
            </p>
          </div>
          <div className="progress-count">
            <strong>{completedSteps}</strong>
            <span>of 8 complete</span>
          </div>
        </div>

        <div className="progress-track" aria-label={`${completedSteps} of 8 steps complete`}>
          <span style={{ width: `${(completedSteps / 8) * 100}%` }} />
        </div>

        <div className="steps-list">
          {SETUP_STEPS.map((step) => {
            const complete = step.number === 1 && detailsComplete;
            const available = step.number === 1;
            return (
              <article
                className={`step-card ${available ? "step-available" : "step-locked"} ${
                  complete ? "step-complete" : ""
                }`}
                key={step.number}
              >
                <div className="step-number" aria-hidden="true">
                  {complete ? "✓" : String(step.number).padStart(2, "0")}
                </div>
                <div className="step-copy">
                  <div className="step-meta">{step.section}</div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
                <div className="step-action">
                  {available ? (
                    <button className="text-button" type="button" onClick={onStart}>
                      {complete ? "Review details" : "Start here"}
                      <span aria-hidden="true">→</span>
                    </button>
                  ) : (
                    <span className="locked-label">
                      <span aria-hidden="true">•</span> Locked
                    </span>
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
          <h2>{detailsComplete ? "Build your decision guide" : "Add competition details"}</h2>
          <p>
            {detailsComplete
              ? "Your basic details are saved. Eligibility, selection and elimination rules come next."
              : "Tell Minder who owns this competition and how many teams you plan to shortlist."}
          </p>
          <button className="primary-button full-width" type="button" onClick={onStart} disabled={!isReady}>
            {detailsComplete ? "Review competition details" : "Start setup"}
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
                <div>
                  <strong>{promise.title}</strong>
                  <p>{promise.body}</p>
                </div>
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
        <button className="back-button" type="button" onClick={onCancel}>
          <span aria-hidden="true">←</span> Back to setup
        </button>

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
              <input
                value={details.competitionName}
                onChange={(event) => onChange({ ...details, competitionName: event.target.value })}
                placeholder="For example, Minder Net Zero"
                required
              />
            </label>

            <label className="field">
              <span>Round or year <small>Optional</small></span>
              <input
                value={details.roundName}
                onChange={(event) => onChange({ ...details, roundName: event.target.value })}
                placeholder="For example, 2026 cohort"
              />
            </label>

            <label className="field">
              <span>Target shortlist size</span>
              <input
                type="number"
                min="1"
                inputMode="numeric"
                value={details.shortlistTarget}
                onChange={(event) => onChange({ ...details, shortlistTarget: event.target.value })}
                placeholder="For example, 50"
                required
              />
            </label>

            <label className="field field-wide">
              <span>Person responsible for final approval</span>
              <input
                value={details.organiserName}
                onChange={(event) => onChange({ ...details, organiserName: event.target.value })}
                placeholder="Full name"
                required
              />
              <small>This person will approve the decision guide before assessments begin.</small>
            </label>
          </div>

          <div className="human-control">
            <span className="human-icon" aria-hidden="true">✓</span>
            <div>
              <strong>Human approval is always required</strong>
              <p>Minder cannot make a final shortlist or rejection on its own. This safeguard cannot be switched off.</p>
            </div>
            <span className="always-on">Always on</span>
          </div>

          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
            <button className="primary-button" type="submit" disabled={!formComplete}>
              Save and continue
            </button>
          </div>
        </form>
      </section>

      <aside className="form-help">
        <div className="rail-label">Why this matters</div>
        <h3>A clear owner prevents silent AI decisions.</h3>
        <p>
          Minder records who approved each decision guide and who confirmed every final outcome.
        </p>
        <div className="help-divider" />
        <strong>Nothing is being assessed yet.</strong>
        <p>The assessment remains locked until the later rule, history, test and safeguard steps are complete.</p>
      </aside>
    </div>
  );
}
