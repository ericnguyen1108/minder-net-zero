# Minder Net Zero production operator runbook

This runbook is for the technical Minder operator. The competition organiser should never handle database URLs, Clerk keys, webhook secrets, or any future AI-provider key. Their job begins after the operator has completed the launch checklist and handed them an owner account.

The bootstrap is intentionally two-system and fail-closed:

1. Checked-in migrations create the Postgres foundation.
2. The provisioning script verifies the real Clerk organization and MFA-enrolled owner, creates the Postgres tenant/competition mapping, writes the tenant UUID to Clerk private metadata, and ensures the owner is a Clerk `org:admin` plus an internal Minder `owner`.

If the Clerk update fails after the database commit, access remains unavailable or incomplete; rerun the same command. Do not delete rows to “start again.” The operation is idempotent.

## 0. Supported production boundary

Treat “production platform” and “legacy pilot” as different products:

| Capability | Production platform (`AUTH_MODE=clerk`) | Legacy pilot |
| --- | --- | --- |
| Named accounts, invitations, MFA, and roles | Central and supported | No; one shared password |
| Decision Guide | Central, versioned, approved, and audited | Browser-local |
| Current-application import | Central and supported | Browser-local |
| Reviewer assignment, reviews, human decisions, export, audit | Central and supported | Browser-local or unavailable |
| Historical-example import and calibration | **Not centrally implemented** | Browser-local prototype only |
| Practice safeguards and AI assessment | **Not centrally implemented** | Browser-local prototype using a server AI gateway |
| Recovery | Neon recovery for central data | Downloaded browser backup only |

The current production operating path is rubric → current import → assignment → human review → human decision/export → audit. It may hold real submissions only after every gate in this runbook passes.

Production AI is a hard stop. Leave `OPENAI_API_KEY` and `OPENAI_MODEL` unset in the production deployment. Do not send production candidate text to an AI model until central historical calibration, practice approval, assessment execution/persistence, privacy controls, incident handling, and acceptance tests have been implemented and separately approved. Database tables or dashboard placeholders for future assessment data do not satisfy this gate.

The sidebar **Download backup / Restore** control exists only in legacy mode. It does not back up or restore the production database, Clerk accounts, shared audit history, or reviewer work.

## 1. Launch authority and hard stop

Name these people in the change ticket before doing anything:

- Business owner: approves the competition and go-live.
- Data/privacy owner: approves region, retention, subprocessors, and candidate notice/consent.
- Technical operator: controls Vercel, Clerk, Neon, deployment, and recovery.
- Recovery approver: authorizes a production restore. This should not be the person executing it.

No real candidate application may be imported until all of these are true:

- The data-region decision is written and approved.
- Clerk production Organizations, invitation-only access, and required MFA are enabled.
- Runtime, identity-sync, and migration database credentials are different roles.
- Migration and provisioning dry-runs are clean.
- The authenticated readiness check passes.
- A Neon restore drill has been completed and recorded.
- The organiser has tested one owner login and one reviewer invitation with synthetic data.
- A production-shaped **staging** rehearsal of a synthetic 700-row central import has passed and its evidence is recorded.

### What the nontechnical organiser receives

Hand over only:

- The production web address.
- Their named owner email/account and MFA recovery instructions.
- The name of the Organization and competition they must see after sign-in.
- A support contact and the exact instruction: “Stop importing or reviewing and call us if the organization name, counts, or access looks wrong.”
- The approved operating checklist for the Decision Guide, current import, reviewer assignment, human decisions, export, and audit.

In a supervised 30-minute handoff, have the organiser sign in, select the Organization, invite one synthetic reviewer from **Team**, assign one synthetic application, inspect its audit history, and export a synthetic decision. State plainly that historical calibration and AI assessment are not production features yet. They must not receive Vercel, Neon, Clerk, AI-provider, or database credentials. They should never be asked to edit an environment variable or paste an API key into Minder.

## 2. Decide the data region before creating Neon

Candidate submissions can contain personal and commercially sensitive information. The organiser, as data controller, must decide where it may be processed. Consider applicant location, contract terms, privacy counsel, the competition privacy notice, Vercel execution region, Clerk, Neon, and any cross-border transfer mechanism. The current production path does not send submissions to an AI provider; adding one later requires a new privacy and residency approval.

Create the Neon production project only after that decision. Treat its region as immutable for operations: changing it should be handled as a new-project data migration, not an in-place toggle. Record the chosen code in the ticket and use the same value for `MINDER_DATA_REGION` (for example, `aws-ap-southeast-1`). `MINDER_DATA_REGION` records the decision; it does not itself force Vercel, Clerk, or any future provider into that region.

Reference: [Neon project and region model](https://neon.com/docs/get-started/why-neon).

## 3. Create three separate Postgres roles

Think of the three credentials as three physical keys:

| Key | Used by | Required power | Must never have |
| --- | --- | --- | --- |
| Migration/administration | A technical operator during approved changes | DDL, extension creation, migration table, bootstrap | A place in Vercel runtime variables |
| `minder_runtime` | Normal web/API requests | DML on application tables, always constrained by forced RLS | `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, DDL |
| `minder_identity` | Signed Clerk webhook only | Narrow identity-table grants and `BYPASSRLS` | DDL, deletes, access to candidate/application tables |

The identity role needs `BYPASSRLS` because a membership-created webhook does not yet have an internal user UUID. That is a powerful exception, so its table grants are deliberately narrow. Never reuse `IDENTITY_DATABASE_URL` in ordinary routes.

Plan these roles before deployment. After Section 5 applies the foundation migration, return here, connect with the migration role, and run:

```bash
psql "$DATABASE_ADMIN_URL" -f scripts/sql/least-privilege-roles.sql
```

Then use interactive `psql` commands so passwords do not appear in this repository or copied SQL:

```text
\password minder_runtime
\password minder_identity
ALTER ROLE minder_runtime LOGIN;
ALTER ROLE minder_identity LOGIN;
```

Store the resulting connection URLs directly in the deployment secret manager. Do not paste passwords into tickets, chat, screenshots, or shell history. Confirm both roles are absent from `neon_superuser`; Neon notes that roles made through its Console/API can inherit elevated membership, whereas SQL-created roles receive only what you grant. [Neon role compatibility](https://neon.com/docs/reference/compatibility).

After every future migration, rerun the grants file. Runtime default grants are included; any new identity-sync table must be consciously added and reviewed.

## 4. Configure Clerk production

Use a Clerk production instance, not development keys.

1. Enable Organizations with membership required; disable personal accounts and user-created organizations for this invitation-only product.
2. Keep Clerk roles coarse: the bootstrap owner is `org:admin`; ordinary invitees are `org:member`. Minder’s competition roles remain in Postgres and are checked on every server request.
3. Enable TOTP/authenticator MFA and backup codes, then enable **Require multi-factor authentication**. The owner must complete MFA enrollment before bootstrap. Clerk’s prebuilt sign-in handles the resulting `setup-mfa` task. [Clerk MFA configuration](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options).
4. Create one Organization in the Clerk Dashboard. Do not enable verified-domain auto-enrollment. Copy its `org_...` ID.
5. Create or invite the intended owner, have them verify email and enroll MFA, then copy the `user_...` ID.
6. Do not manually create reviewer mappings. After launch, the owner uses Minder’s **Team** screen; Clerk sends an invitation and the signed webhook activates the requested internal roles. Clerk documents the invitation lifecycle at [Organization invitations](https://clerk.com/docs/guides/organizations/add-members/invitations).

The active Clerk Organization is a tenant selector, not proof by itself. The app also verifies the private `minderTenantId` UUID and the corresponding Postgres organization/user/membership mapping.

## 5. Apply migrations safely

Use an unpooled production connection for `DATABASE_ADMIN_URL`. The script refuses a non-TLS remote URL, refuses an admin role reused by `DATABASE_URL` or `IDENTITY_DATABASE_URL`, validates journal-to-SQL hashes, checks previously recorded hashes, and serializes concurrent applies with a Postgres advisory lock. It never prints a connection URL or password.

Load secrets from the approved password manager into an isolated terminal session; do not type literal secrets into the command itself.

```bash
npm run db:migrate -- --dry-run
npm run db:migrate -- --apply
```

Before `--apply`, create a Neon snapshot/recovery marker and record the UTC time, code commit, operator, approver, and expected migration tags. Never generate schema changes in production with `drizzle-kit push`; production accepts checked-in migration files only.

## 6. Provision the first owner, tenant, and competition

Set these operator-only inputs in the isolated shell:

```text
DATABASE_ADMIN_URL                 unpooled migration/administration URL
CLERK_SECRET_KEY                   Clerk production secret key
CLERK_ORGANIZATION_ID              exact org_... ID
CLERK_OWNER_USER_ID                exact user_... ID
MINDER_DEPLOYMENT_ENV              production
MINDER_COMPETITION_NAME            organiser-approved display name
MINDER_COMPETITION_SLUG            lowercase stable slug
MINDER_COMPETITION_TIMEZONE        IANA timezone, e.g. Asia/Ho_Chi_Minh
MINDER_DATA_REGION                 approved lowercase region code
MINDER_DATA_REGION_APPROVED        YES
```

Run the read-only preflight:

```bash
npm run platform:provision -- --dry-run
```

For apply, also set `MINDER_BOOTSTRAP_CONFIRM` to the exact value `<CLERK_ORGANIZATION_ID>:<MINDER_COMPETITION_SLUG>`, then run:

```bash
npm run platform:provision -- --apply
```

The script fails on an unverified/locked owner, missing MFA, unsafe names, a conflicting email/slug/tenant, changed region, archived records, missing migrations, reused admin credentials, or malformed Clerk metadata. It does not log the owner email or any secret. New UUIDs are generated only during apply, not promised by dry-run. Tenant and competition UUIDs are identifiers, not credentials; record the successful apply output in the restricted change ticket.

Rerunning the command with the same inputs is the supported repair for a partial Clerk update. A different region, organization, or competition identity is a separate migration/change—not a bootstrap rerun.

## 7. Runtime environment variables

Set variables separately for Vercel Production and Preview. Preview must use a different Clerk instance and Neon branch/project with synthetic data.

| Variable | Scope | Requirement |
| --- | --- | --- |
| `AUTH_MODE` | Server | Exactly `clerk` at cutover |
| `NEXT_PUBLIC_AUTH_MODE` | Browser/server | Exactly `clerk` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Browser | Matching production Clerk publishable key |
| `CLERK_SECRET_KEY` | Server secret | Matching Clerk production key |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Server secret | Secret for this exact production webhook endpoint |
| `DATABASE_URL` | Server secret | Pooled URL using `minder_runtime`, TLS required |
| `IDENTITY_DATABASE_URL` | Server secret | Dedicated URL using `minder_identity`, TLS required |
| `DB_POOL_MAX` | Server | Start small (the app defaults to 3) and tune from measured load |
| `DB_CONNECT_TIMEOUT_SECONDS` | Server | Keep bounded; default is 10 |
| `DB_IDLE_TIMEOUT_SECONDS` | Server | Keep bounded; default is 20 |

`DATABASE_ADMIN_URL` and all `MINDER_*` bootstrap confirmations are operator-only and must not be deployed to Vercel. `ORGANISER_ACCESS_CODE`, `SESSION_SECRET`, and `AUTH_KV_REST_API_*` are legacy-only and must remain unset after Clerk cutover. `OPENAI_API_KEY` and `OPENAI_MODEL` are not required by the current production workflow and must also remain unset. Rotate a credential immediately if it appears in logs, chat, a ticket, or a screen recording.

## 8. Configure and test the Clerk webhook

Create one Clerk production webhook endpoint:

```text
https://<production-domain>/api/webhooks/clerk
```

Subscribe only to the events the checked-in handler processes:

- `organizationMembership.created`
- `organizationMembership.updated`
- `organizationMembership.deleted`
- `organizationInvitation.accepted`
- `organizationInvitation.revoked`

Copy that endpoint’s signing secret to `CLERK_WEBHOOK_SIGNING_SECRET`. The route is publicly reachable because Clerk is not signed in, but every request is signature-verified and replay-protected. Clerk retries non-2xx deliveries; inspect and replay failures from the Clerk/Svix dashboard after fixing the cause. [Clerk webhook verification](https://clerk.com/docs/reference/backend/verify-webhook) and [sync guide](https://clerk.com/docs/guides/development/webhooks/syncing).

Test with synthetic accounts:

1. Owner invites one reviewer from Minder’s Team screen.
2. Reviewer accepts, enrolls MFA, selects the Organization, and sees only assigned reviews.
3. Owner changes the reviewer’s Minder role and confirms access changes.
4. Remove the reviewer in Clerk and confirm access is revoked and active grants are revoked.
5. Confirm every event shows a 2xx delivery and a corresponding central audit event.

Do not invite the real competition review team until this exact flow passes.

## 9. Synthetic 700-row rehearsal and go-live checks

The code accepts at most 1,000 rows per central import and sends at most 25 rows per chunk. These are safety bounds, not a load-test result. Rehearse the actual 700-team shape in a dedicated staging Clerk Organization, Vercel deployment, and Neon branch/project before importing real data. Match the production release, region, database plan, and runtime settings as closely as possible; never load the rehearsal cohort into the real competition tenant.

1. Create a synthetic spreadsheet with exactly 700 unique stable application IDs, representative answer-column count and representative text sizes. Use no real names, emails, submissions, or copied applicant prose.
2. Import it through the organiser UI. A 700-row file should publish in 28 verified chunks. Do not bypass the UI with direct database inserts.
3. Confirm the UI and central database show exactly 700 applications. Spot-check the first, middle, and last records, identity/answer separation, and the `application.import_completed` audit event with `recordCount: 700`.
4. Record total duration, any retry/error, Vercel failures/timeouts, database saturation, and maximum observed connections. The business and technical owners must agree the acceptable time before the rehearsal; the repository does not promise a latency SLO.
5. Assign a representative synthetic sample to at least two reviewer accounts. Submit and revise reviews, record and revise human decisions, export them, and verify that role restrictions and audit events remain correct.
6. Preserve the restricted test evidence, then destroy the isolated staging deployment, credentials, Clerk test accounts/Organization, and Neon branch/project according to policy. Do not overwrite the synthetic cohort with real data or manually delete rows from the production database.

Automated import tests protect row limits, hashes, chunking, retries, and transaction behavior. They are engineering regression tests and do not replace this environment rehearsal.

After deployment:

1. Open `/api/health/live`; it must return only liveness and no configuration details.
2. Sign in as the MFA-enrolled owner, select the correct Organization, then open `/api/health/ready`; database, Clerk configuration, and administrator authorization must pass.
3. Confirm a signed-out request cannot reach Team, Review, Audit, or platform API pages.
4. Confirm the owner can view the central audit log and a reviewer cannot.
5. Confirm the full 700-row staging rehearsal above passed on this exact release and production-equivalent settings; a small smoke import alone is insufficient.
6. Record UTC time, deployment ID, code commit, migration hashes, tenant/competition IDs, benchmark evidence, and test evidence in the change ticket.

Only the business owner and technical operator together remove the “no real data” hold.

## 10. Neon backup, PITR, and restore drill

A backup that has never been restored is only a hope. Set measurable targets before launch; a reasonable starting point for this competition is an RPO of 15 minutes and RTO of 4 hours, but the organiser must approve the actual targets and buy a Neon plan/retention window that can meet them.

Neon recovery covers the central Decision Guide, current applications, assignments, reviews, decisions, and database audit events. Clerk identity/invitation state and external Vercel/Clerk logs are separate systems; document how each will be reconstructed or retained. A Neon restore does not restore those external systems.

Legacy browser backups are unrelated to this procedure. They cover only the browser-local pilot workspace that created the file, may contain sensitive test text, and must not be treated as a production backup or merged into the central database.

Configure:

- The approved Neon history-retention window long enough to cover detection over weekends/holidays.
- Scheduled snapshots at least daily where the selected plan supports them, with retention matching policy.
- A snapshot immediately before migrations, bulk imports, role changes, and mass decisions.
- A periodic encrypted logical export stored outside the Neon project if policy requires provider-independent recovery. Treat it as candidate data: encrypt, restrict, test, and delete on schedule.
- Alerts for database availability, storage/compute limits, webhook failure, and readiness failure.

Neon’s Backup & Restore combines point-in-time restore and snapshots; plan limits and snapshot availability can change, so verify the selected plan in the Console rather than assuming a default. [Neon Backup & Restore update](https://neon.com/docs/changelog/2025-10-31) and [point-in-time restore workflow](https://neon.com/blog/announcing-point-in-time-restore).

Perform this restore drill before launch and at least quarterly (monthly during an active high-stakes competition):

1. Write a synthetic marker row/change and record its UTC time.
2. Create an isolated branch from a point immediately before the marker or from a snapshot. Never restore production first.
3. Create temporary, isolated credentials; do not reuse production URLs in a laptop tool.
4. Verify migrations, organization/competition counts, application counts, immutable review revisions, and audit-chain continuity. Confirm the marker’s expected presence/absence.
5. Start a non-public test deployment against the restored branch and complete a read-only smoke test.
6. Record actual RPO/RTO, approver, evidence, and any gap.
7. Destroy the temporary deployment, credentials, compute, and branch after approval.

## 11. Rollback and incident paths

### Code release fails, database is healthy

Roll Vercel back to the last known-good deployment that is compatible with the expanded schema. Migrations must be forward-compatible/expand-first. Do not run ad-hoc down SQL and do not delete migration records.

### Migration command fails

The migration statements are transactional; stop, retain the full private operator error, and inspect before retrying. Do not mark the release complete. If a migration was recorded, compare the checked-in hash with `drizzle.__drizzle_migrations`; never edit the hash table manually.

### Bootstrap stops after Postgres but before Clerk

Keep `AUTH_MODE` off or the deployment inaccessible, fix the Clerk/MFA/configuration issue, and rerun `platform:provision -- --apply` with identical inputs. This is the expected repair path.

### Wrong Clerk organization or region was chosen

Stop before importing data. Disable production access, revoke affected Clerk membership, preserve evidence, and open a new approved migration ticket. Do not repoint `minderTenantId` or overwrite `data_region` casually; tenant identity and residency changes require an explicit migration and audit trail.

### Production data is damaged or deleted

1. Put the app into maintenance/no-write mode by rolling back or disabling traffic.
2. Record the incident and preserve external Clerk/Vercel logs; a database restore also rewinds database audit events.
3. Use Neon time-travel preview to locate the last correct timestamp.
4. Restore to an isolated branch and verify it using the drill checklist.
5. Recovery approver authorizes the cutover.
6. Update both runtime URLs together only if the restored branch has the expected two least-privilege roles; rotate credentials after the incident.
7. Run readiness and synthetic smoke tests before reopening.

### A secret is exposed

Disable or rotate it at the provider first, update Vercel, redeploy, verify readiness, and then investigate. For `CLERK_WEBHOOK_SIGNING_SECRET`, create/rotate the endpoint secret and verify delivery. For a database credential, terminate old sessions where practical. Never “wait until after the competition.”

## 12. Routine operating cadence

- Daily during review: check readiness, failed Clerk webhook deliveries, failed imports, incomplete reviewer work, and unexpected denied audit events.
- Weekly: review active users/roles, remove leavers, confirm snapshot jobs, and check capacity/cost.
- Before every bulk import or mass decision operation: snapshot, freeze the approved Guide version, and record operator/approver.
- Monthly during an active competition: restore drill and privileged-access review.
- After the competition: revoke temporary reviewers, rotate high-risk credentials, export required records, apply the approved retention/deletion schedule, and archive rather than silently delete immutable evidence.
