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

Phases 1 and 2 are implemented. The app now includes the eight-step organiser journey plus a plain-language Decision Guide builder for eligibility, elimination, scoring criteria, weights, score anchors, recommendation thresholds, tie-break priorities, missing-information safeguards, validation, human approval, and immutable approved versions. Drafts remain device-local until secure shared persistence is added in a later phase.

## Local development

```bash
npm run dev
```

## Validation

```bash
npm test
```
