import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assignApplicationToReviewer,
  assignmentCanBeCancelled,
  assignmentCanBeReactivated,
  unassignApplicationFromReviewer,
} from "../lib/assignment-management.ts";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const COMPETITION_ID = "22222222-2222-4222-8222-222222222222";
const APPLICATION_ID = "33333333-3333-4333-8333-333333333333";
const REVIEWER_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-4555-8555-555555555555";
const ASSIGNMENT_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2027-05-06T07:08:09.000Z");

function fakeTransaction({ selections = [], inserted = null, updated = null } = {}) {
  const captured = { inserted: null, updated: null, updateCalls: 0, insertCalls: 0 };
  let selection = 0;
  const transaction = {
    select() {
      const rows = selections[selection++] ?? [];
      const query = {
        from() { return query; },
        innerJoin() { return query; },
        where() { return query; },
        orderBy() { return query; },
        async limit() { return rows; },
      };
      return query;
    },
    update() {
      captured.updateCalls += 1;
      const query = {
        set(value) {
          captured.updated = value;
          return query;
        },
        where() { return query; },
        async returning() { return updated ? [updated] : []; },
      };
      return query;
    },
    insert() {
      captured.insertCalls += 1;
      const query = {
        values(value) {
          captured.inserted = value;
          return query;
        },
        async returning() { return inserted ? [inserted] : []; },
      };
      return query;
    },
  };
  return { transaction, captured };
}

function assignment(overrides = {}) {
  return {
    id: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    competitionId: COMPETITION_ID,
    applicationId: APPLICATION_ID,
    reviewerUserId: REVIEWER_ID,
    round: 1,
    status: "assigned",
    blind: true,
    revision: 1,
    assignedByUserId: ACTOR_ID,
    assignedAt: NOW,
    dueAt: null,
    completedAt: null,
    ...overrides,
  };
}

function assignInput(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    competitionId: COMPETITION_ID,
    applicationId: APPLICATION_ID,
    reviewerUserId: REVIEWER_ID,
    actorUserId: ACTOR_ID,
    round: 1,
    blind: true,
    dueAt: null,
    expectedRevision: null,
    now: NOW,
    ...overrides,
  };
}

test("assignment transition helpers fail closed", () => {
  assert.equal(assignmentCanBeCancelled("assigned"), true);
  assert.equal(assignmentCanBeCancelled("in_progress"), true);
  assert.equal(assignmentCanBeCancelled("submitted"), false);
  assert.equal(assignmentCanBeCancelled("cancelled"), false);
  assert.equal(assignmentCanBeReactivated("cancelled"), true);
  assert.equal(assignmentCanBeReactivated("reassigned"), true);
  assert.equal(assignmentCanBeReactivated("assigned"), false);
  assert.equal(assignmentCanBeReactivated("submitted"), false);
});

test("reviewer self-assignment is rejected before a reviewer lookup or write", async () => {
  const { transaction, captured } = fakeTransaction({ selections: [[{ id: APPLICATION_ID }]] });
  await assert.rejects(
    assignApplicationToReviewer(
      transaction,
      assignInput({ reviewerUserId: ACTOR_ID }),
    ),
    /self_assignment_forbidden/,
  );
  assert.equal(captured.insertCalls, 0);
  assert.equal(captured.updateCalls, 0);
});

test("a new assignment records only the server-derived actor and starts at revision one", async () => {
  const created = assignment();
  const { transaction, captured } = fakeTransaction({
    selections: [[{ id: APPLICATION_ID }], [{ id: REVIEWER_ID }], []],
    inserted: created,
  });
  const result = await assignApplicationToReviewer(transaction, assignInput());
  assert.deepEqual(result, { assignment: created, action: "assignment.created" });
  assert.equal(captured.inserted.tenantId, TENANT_ID);
  assert.equal(captured.inserted.reviewerUserId, REVIEWER_ID);
  assert.equal(captured.inserted.assignedByUserId, ACTOR_ID);
  assert.equal(captured.inserted.revision, 1);
  assert.equal(captured.inserted.status, "assigned");
});

test("reactivation requires the exact inactive assignment revision", async () => {
  const inactive = assignment({ status: "cancelled", revision: 3 });
  const { transaction, captured } = fakeTransaction({
    selections: [[{ id: APPLICATION_ID }], [{ id: REVIEWER_ID }], [inactive]],
  });
  await assert.rejects(
    assignApplicationToReviewer(transaction, assignInput({ expectedRevision: 2 })),
    /revision_conflict/,
  );
  assert.equal(captured.updateCalls, 0);
  assert.equal(captured.insertCalls, 0);
});

test("submitted assignments are immutable through assignment management", async () => {
  const submitted = assignment({ status: "submitted", revision: 4, completedAt: NOW });
  const { transaction, captured } = fakeTransaction({ selections: [[submitted]] });
  await assert.rejects(
    unassignApplicationFromReviewer(transaction, {
      tenantId: TENANT_ID,
      competitionId: COMPETITION_ID,
      assignmentId: ASSIGNMENT_ID,
      expectedRevision: 4,
    }),
    /submitted_assignment_locked/,
  );
  assert.equal(captured.updateCalls, 0);
});

test("unassignment is an optimistic revision transition, never a delete", async () => {
  const current = assignment({ status: "in_progress", revision: 2 });
  const cancelled = assignment({ status: "cancelled", revision: 3 });
  const { transaction, captured } = fakeTransaction({ selections: [[current]], updated: cancelled });
  const result = await unassignApplicationFromReviewer(transaction, {
    tenantId: TENANT_ID,
    competitionId: COMPETITION_ID,
    assignmentId: ASSIGNMENT_ID,
    expectedRevision: 2,
  });
  assert.deepEqual(result, { assignment: cancelled, previousStatus: "in_progress" });
  assert.equal(captured.updated.status, "cancelled");
  assert.equal(captured.insertCalls, 0);
});

test("assignment API resolves tenant and roles on the server and audits mutations in-transaction", async () => {
  const [route, repository, page, migration] = await Promise.all([
    readFile(new URL("../app/api/platform/assignments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/assignment-management.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/assignments/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_production_foundation.sql", import.meta.url), "utf8"),
  ]);

  assert.match(route, /resolveRequestPlatformContext\(\)/);
  assert.match(route, /requirePermission\(principal, "review\.assign"/);
  assert.equal((route.match(/sameOriginMutation\(request\)/g) ?? []).length, 2);
  assert.equal((route.match(/readPlatformJson\(request\)/g) ?? []).length, 2);
  assert.equal((route.match(/appendPostgresAuditEvent\(transaction/g) ?? []).length, 2);
  assert.match(route, /isolationLevel: "serializable"/);
  assert.doesNotMatch(route, /tenantId:\s*z\./);
  assert.doesNotMatch(route, /actorUserId:\s*z\./);
  assert.match(repository, /ne\(users\.id, input\.actorUserId\)/);
  assert.match(repository, /eq\(assignments\.revision, input\.expectedRevision\)/);
  assert.match(page, /permissions\.includes\("review\.assign"\)/);
  assert.match(migration, /'assignments'[\s\S]*ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /'assignments'[\s\S]*ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/i);
});
