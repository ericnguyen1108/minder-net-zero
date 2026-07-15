# Minder Net Zero

Minder Net Zero is a guided application-review workspace for competition organisers who are not technical. It helps organisers define an approved decision guide, teach Minder from historical decisions, test the assessment safely, import current applications, and keep final decisions with people.

## Product rules

- Minder makes recommendations; authorised people make final decisions.
- Applicant claims must be supported by evidence from the submitted text.
- Missing information is never guessed.
- Unclear, conflicting, or borderline cases go to human review.
- Historical patterns do not become rules until an organiser approves them.
- Rule changes create a new version and do not silently change old results.

## Delivery phases

1. Guided setup journey and approval gates
2. Decision Guide builder and version approval
3. Historical data import and validation
4. Decision-guide learning and practice testing
5. Evidence-bound batch assessment
6. Human review, exports, roles, secure persistence, and managed AI operation

## Current phase

Phases 1–5 are implemented. The app now includes the eight-step organiser journey, an approved and versioned Decision Guide, a guided historical-data importer, organiser-reviewed teaching patterns, a one-use blind practice test, locked operating safeguards, current-application reconciliation, and resumable evidence-bound assessment.

Historical application text is kept out of `localStorage` and stored in separate teaching and sealed-test IndexedDB stores. Phase 4 sends only allow-listed pseudonymous row IDs and mapped answers through a server gateway. Separate identity columns are excluded, but names or contact details embedded inside an answer are not automatically redacted. Teaching requests may include historical outcomes; blind practice requests never include them. Every AI result uses a strict output schema, and every quotation is rechecked against the exact current answer before the app calculates a weighted score locally. Because exact text can still be irrelevant, an organiser must also approve a fixed human evidence sample before the run can pass.

Sealed outcomes are unavailable until a complete prediction set is durably committed. Revealing them creates a minimal, permanent browser receipt keyed by the historical-set fingerprint, so deleting and re-importing the same file cannot make it blind again. State changes are monotonic and revision-checked to stop stale tabs or unsafe reversals.

Phase 5 freezes one complete current-application set and refuses missing, duplicate, conflicting or oversized rows rather than silently excluding a candidate. Application identity is stored separately from answer text. The AI receives only opaque case IDs, the approved answer fields, the approved guide and organiser-approved historical context. Requests are contract-bound, limited to six cases, resumable, and rejected if the guide, data, model, prompt, schema or evidence does not match. The exact assessment instructions, schema and validation protocol are hashed into the practice-test, safeguard and run receipts; a changed protocol cannot reuse the old approval.

Scores and shortlist-zone rankings are calculated locally only after every case is accounted for. Unsupported, unclear and malformed cases go to Human Review; exact shortlist-boundary ties go to people. A fixed human evidence-relevance sample shows every evidence-bearing finding and quotation before it can pass. Failed audit runs remain immutable, identical retries are blocked, and corrected source data creates a separate sealed set without deleting the old audit record. Final decisions and exports remain locked for Phase 6.

This remains a test-data-only prototype. Browser storage is device-local and evictable, and the app still has no shared managed candidate database, role-based reviewer assignment, production audit service or backup. Do not use real candidate data until those controls are added. Phase 5 permits only a supervised, de-identified pilot; it does not enable autonomous decisions.

## Managed AI connection

The organiser interface never asks for an API key. A Minder administrator provisions `OPENAI_API_KEY` and pins `OPENAI_MODEL` as server-side deployment secrets. Without them, Phases 4 and 5 fail closed and accurately report that no application text has been sent. The app uses the OpenAI Responses API with structured outputs and `store: false`; retention still depends on the organisation’s OpenAI project and data-control settings. Phase 5 requires the exact model used in the passed practice test—no silent model substitution is accepted.

## Local development

```bash
npm run dev
```

## Validation

```bash
npm test
```
