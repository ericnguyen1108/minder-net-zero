import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlatformContext } from "../lib/auth/context.ts";
import { submitReviewerReview } from "../lib/platform-repository.ts";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNMENT_ID = "33333333-3333-4333-8333-333333333333";
const APPLICATION_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_ID = "55555555-5555-4555-8555-555555555555";

function reviewerPrincipal() {
  const result = resolvePlatformContext(
    {
      provider: "clerk",
      providerUserId: "user_clerk_1",
      providerOrganizationId: "org_clerk_1",
      sessionId: "sess_clerk_1",
      tenantId: TENANT_ID,
    },
    [
      {
        provider: "clerk",
        authSubject: "user_clerk_1",
        organizationAuthProvider: "clerk",
        organizationAuthSubject: "org_clerk_1",
        userId: "usr_1",
        userDisplayName: "Ada Reviewer",
        userDisabledAt: null,
        tenantId: TENANT_ID,
        organizationName: "Net Zero Foundation",
        organizationSlug: "net-zero-foundation",
        organizationArchivedAt: null,
        membershipStatus: "active",
        competitionId: "competition_1",
        competitionName: "2027 Net Zero Challenge",
        competitionStatus: "reviewing",
        competitionArchivedAt: null,
        role: "reviewer",
      },
    ],
  );
  assert.equal(result.ok, true);
  return result.principals[0];
}

function fakeSubmissionTransaction({ assignment, latest = null, updated = null }) {
  let selectNumber = 0;
  const captured = { updateSet: null, insertedReview: null };
  const transaction = {
    select() {
      const rows = selectNumber++ === 0 ? (assignment ? [assignment] : []) : latest ? [latest] : [];
      const query = {
        from() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        async limit() {
          return rows;
        },
      };
      return query;
    },
    update() {
      const query = {
        set(value) {
          captured.updateSet = value;
          return query;
        },
        where() {
          return query;
        },
        async returning() {
          return updated ? [updated] : [];
        },
      };
      return query;
    },
    insert() {
      return {
        async values(value) {
          captured.insertedReview = value;
        },
      };
    },
  };
  return { transaction, captured };
}

function assignment(revision, status) {
  return {
    id: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    competitionId: "competition_1",
    applicationId: APPLICATION_ID,
    reviewerUserId: "usr_1",
    revision,
    status,
    completedAt: status === "submitted" ? new Date("2027-02-01T00:00:00.000Z") : null,
  };
}

function submissionInput(overrides = {}) {
  return {
    principal: reviewerPrincipal(),
    assignmentId: ASSIGNMENT_ID,
    expectedRevision: 1,
    decision: "progress",
    confidence: "high",
    notes: "The evidence supports progressing this application.",
    now: new Date("2027-03-04T05:06:07.000Z"),
    ...overrides,
  };
}

test("first review submission advances the assignment and writes immutable revision one", async () => {
  const original = assignment(1, "assigned");
  const next = { ...original, revision: 2, status: "submitted", completedAt: submissionInput().now };
  const { transaction, captured } = fakeSubmissionTransaction({ assignment: original, updated: next });

  const result = await submitReviewerReview(transaction, submissionInput());

  assert.deepEqual(result, { assignment: next, reviewRevision: 1 });
  assert.equal(captured.updateSet.status, "submitted");
  assert.equal(captured.updateSet.completedAt.toISOString(), "2027-03-04T05:06:07.000Z");
  assert.equal(captured.insertedReview.revision, 1);
  assert.equal(captured.insertedReview.supersedesReviewId, null);
  assert.equal(captured.insertedReview.status, "submitted");
  assert.equal(captured.insertedReview.recommendation, "progress");
  assert.equal(captured.insertedReview.rationale, submissionInput().notes);
  assert.deepEqual(captured.insertedReview.flags, { confidence: "high" });
  assert.match(captured.insertedReview.contentHash, /^[a-f0-9]{64}$/);
});

test("a submitted assignment may be revised without overwriting its prior review", async () => {
  const original = assignment(2, "submitted");
  const next = {
    ...original,
    revision: 3,
    completedAt: new Date("2027-03-04T06:00:00.000Z"),
  };
  const latest = { id: REVIEW_ID, revision: 1 };
  const { transaction, captured } = fakeSubmissionTransaction({
    assignment: original,
    latest,
    updated: next,
  });
  const input = submissionInput({
    expectedRevision: 2,
    decision: "human_review",
    confidence: "medium",
    notes: "The new evidence is material and needs a human panel review.",
    now: next.completedAt,
  });

  const result = await submitReviewerReview(transaction, input);

  assert.deepEqual(result, { assignment: next, reviewRevision: 2 });
  assert.equal(captured.insertedReview.revision, 2);
  assert.equal(captured.insertedReview.supersedesReviewId, REVIEW_ID);
  assert.equal(captured.insertedReview.recommendation, "human_review");
  assert.equal(captured.insertedReview.rationale, input.notes);
  assert.deepEqual(captured.insertedReview.flags, { confidence: "medium" });
  assert.match(captured.insertedReview.contentHash, /^[a-f0-9]{64}$/);
});

test("an optimistic revision conflict fails before a reviewer review is inserted", async () => {
  const original = assignment(2, "submitted");
  const { transaction, captured } = fakeSubmissionTransaction({
    assignment: original,
    latest: { id: REVIEW_ID, revision: 1 },
    updated: null,
  });

  await assert.rejects(
    submitReviewerReview(transaction, submissionInput({ expectedRevision: 1 })),
    /revision_conflict/,
  );
  assert.equal(captured.insertedReview, null);
});

test("a missing assignment returns null and performs no write", async () => {
  const { transaction, captured } = fakeSubmissionTransaction({ assignment: null });
  const result = await submitReviewerReview(transaction, submissionInput());
  assert.equal(result, null);
  assert.equal(captured.updateSet, null);
  assert.equal(captured.insertedReview, null);
});
