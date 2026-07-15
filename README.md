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

Phases 1–3 are implemented. The app now includes the eight-step organiser journey, an approved and versioned Decision Guide, and a guided historical-data importer for Excel, CSV and TSV files. Organisers confirm column and outcome mappings, review missing, duplicate and linked records, and create one fixed, outcome-balanced split with approximately 80% for teaching and 20% for a blind practice check.

Historical application text is kept out of `localStorage` and stored in separate teaching and sealed-test IndexedDB stores. The active dataset pointer is committed with the records, and an integrity check fails closed if stored content or assignments change. Phase 4 can read only verified teaching records. This remains a browser-only prototype: it does not send data to AI, but it is not a production secure workspace and must not be used with real candidate data until authentication and managed storage are added. This release expects applications and final outcomes in the same spreadsheet.

## Local development

```bash
npm run dev
```

## Validation

```bash
npm test
```
