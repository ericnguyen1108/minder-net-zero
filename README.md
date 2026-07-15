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

Phases 1–4 are implemented. The app now includes the eight-step organiser journey, an approved and versioned Decision Guide, a guided historical-data importer, organiser-reviewed teaching patterns, and a one-use blind practice test.

Historical application text is kept out of `localStorage` and stored in separate teaching and sealed-test IndexedDB stores. Phase 4 sends only allow-listed pseudonymous row IDs and mapped answers through a server gateway. Separate identity columns are excluded, but names or contact details embedded inside an answer are not automatically redacted. Teaching requests may include historical outcomes; blind practice requests never include them. Every AI result uses a strict output schema, and every quotation is rechecked against the exact current answer before the app calculates a weighted score locally. Because exact text can still be irrelevant, an organiser must also approve a fixed human evidence sample before the run can pass.

Sealed outcomes are unavailable until a complete prediction set is durably committed. Revealing them creates a minimal, permanent browser receipt keyed by the historical-set fingerprint, so deleting and re-importing the same file cannot make it blind again. State changes are monotonic and revision-checked to stop stale tabs or unsafe reversals.

This remains a test-data-only prototype. It has no shared managed candidate database, roles or production audit service yet. Do not use real candidate data until those controls are added. Passing Phase 4 means only that an organiser may consider a supervised pilot; it does not enable live assessment or autonomous decisions.

## Managed AI connection

The organiser interface never asks for an API key. A Minder administrator provisions `OPENAI_API_KEY` as a server-side deployment secret and may optionally pin `OPENAI_MODEL`. Without that secret, Phase 4 fails closed and accurately reports that no application text has been sent. The app uses the OpenAI Responses API with structured outputs and `store: false`; retention still depends on the organisation’s OpenAI project and data-control settings.

## Local development

```bash
npm run dev
```

## Validation

```bash
npm test
```
