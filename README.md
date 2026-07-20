# Minder Net Zero

Minder Net Zero is a guided competition-review platform for organisers who are not technical. It keeps the rubric, applications, reviewer work, final decisions, and audit history in one accountable workflow. Minder may support a recommendation; authorised people make every final decision.

## Product rules

- Use only evidence in the submitted text; never invent missing information.
- Send unclear, conflicting, or borderline cases to a person.
- Historical patterns never become rules until an organiser approves them.
- Rule changes create a new version and never silently rewrite old work.
- Applicant identity stays separate from assessable answer text.

## Two modes — do not mix them

| Mode | How it is enabled | Intended use | Data model |
| --- | --- | --- | --- |
| **Production platform** | Both `AUTH_MODE=clerk` and `NEXT_PUBLIC_AUTH_MODE=clerk` | Named organiser and reviewer accounts | Shared Postgres data, role checks, revision history, and central audit |
| **Legacy Postgres pilot** | Any other setting | Local development and supervised, de-identified experiments only | Shared password; central Postgres competition records; browser-local setup draft |

Production mode currently supports:

- Clerk Organizations, invitations, required MFA, and separate owner, competition-admin, rubric-manager, reviewer, decision-approver, and auditor roles.
- A central, versioned Decision Guide.
- A central current-application import, with identity separated from answer text.
- Reviewer assignment, independent review revisions, human decision revisions, guarded CSV export, and a central audit log.
- Tenant-scoped Postgres access enforced by server authorization and forced row-level security.

Legacy mode contains the guided historical-calibration and Phase 4/5 AI prototype. On the `postgres-pilot-port` line, historical/current cohorts, calibration, assessment, reviewer marks, ranking, and final decisions are central Postgres records. The initial setup form and editable Decision Guide journey still begin in browser storage; the approved guide is integrity-bound and copied centrally before human marking. This remains a shared-password pilot, not individual-account production.

## Honest production boundary

The following are **not yet production-backed workflows**:

- Central historical-example import and calibration.
- Central practice-test/safeguard approval.
- Central AI assessment execution, result persistence, retry operations, or cost monitoring.

The database schema and dashboard contain foundations for future historical and assessment records, but that does not make those workflows operational. Do not route real candidate text to an AI model from the production platform until central calibration, assessment persistence, privacy review, operational controls, and acceptance tests have been implemented and approved.

The existing Phase 4/5 gateway is a legacy pilot: it calls the OpenAI Responses API server-side with structured output and `store: false`, then saves the pilot workflow centrally in the dedicated `netzero` / `netzero_ai` Postgres schemas. It is not model training or fine-tuning, and it is not the Clerk-backed production assessment system. `OPENAI_API_KEY` and `OPENAI_MODEL` are therefore not required for the current production platform and should remain unset there.

The browser **Setup backup / Restore** control also belongs only to legacy mode. It covers setup and Decision Guide journey progress only; it does not back up Postgres, Clerk, reviewer accounts, central audit history, marks, assessments, or decisions.

## The 700-application cohort

The central importer accepts 1–1,000 applications in one complete cohort and uploads at most 25 rows per verified chunk. It rejects duplicate IDs, mismatched counts/hashes, oversized data, and partial finalisation; successful publish is atomic and audited. A 700-row import therefore uses 28 chunks.

Those limits and automated regression tests are safety checks, not proof of production performance. Before go-live, the operator must run the documented synthetic 700-row rehearsal in an isolated, production-shaped staging environment, record duration and errors, verify exactly 700 central records, and complete a sample assignment/review/decision/export cycle.

## Production deployment

The production platform requires Clerk, Neon/Postgres, and Vercel (or another Node host). Follow the [production operator runbook](docs/production-runbook.md) end to end. The organiser receives only the web address, their named account, MFA recovery instructions, and a support contact—never infrastructure credentials or environment variables.

Runtime deployment secrets:

- `AUTH_MODE=clerk` and `NEXT_PUBLIC_AUTH_MODE=clerk`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SIGNING_SECRET`
- `DATABASE_URL` using the least-privilege `minder_runtime` role
- `IDENTITY_DATABASE_URL` using the narrowly granted `minder_identity` role

`DATABASE_ADMIN_URL` uses a third migration/administration role. It is operator-only and must never be deployed as a runtime variable. The same is true for `CLERK_ORGANIZATION_ID`, `CLERK_OWNER_USER_ID`, and the `MINDER_*` bootstrap confirmations. See [.env.example](.env.example) for the separated examples.

Safe operator preflights:

```bash
npm run db:migrate -- --dry-run
npm run platform:provision -- --dry-run
```

No real application may be imported until the runbook's region, privacy, Clerk invitation/MFA/webhook, least-privilege database, readiness, synthetic 700-row rehearsal, and restore-drill gates pass.

## Legacy Postgres pilot deployment

Legacy mode uses `ORGANISER_ACCESS_CODE`, `SESSION_SECRET`, a TLS `PILOT_DATABASE_URL` whose runtime login belongs to `netzero_app`, and optional Upstash REST credentials for password changes. Apply `migrations/pilot/*.sql` through a separate direct administrator connection before deployment. It is a single-workspace shared-login pilot, not a multi-user platform. Use test or deliberately de-identified data only until a production-shaped Supabase rehearsal, backup/restore drill, and operator approval have passed.

## Local development

```bash
npm run dev
```

The example environment defaults to legacy mode so a copied local file cannot accidentally pretend to be a production deployment. Production is an explicit two-variable cutover.

## Validation

```bash
npm run lint
npm test
scripts/pilot-test-db.sh
```
