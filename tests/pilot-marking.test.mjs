// Integration test for the human-side pilot repository, run against a REAL
// PostgreSQL database as the actual runtime role (a member of netzero_app).
//
// Gated on TEST_PILOT_DATABASE_URL so the suite still passes where no Postgres
// is available. The harness scripts/pilot-test-db.sh provisions a throwaway
// database, applies the pilot migration, creates the app-role login, and exports
// TEST_PILOT_DATABASE_URL before running this file.

import assert from "node:assert/strict";
import test from "node:test";

const url = process.env.TEST_PILOT_DATABASE_URL;

if (!url) {
  test("pilot marking repository (skipped: set TEST_PILOT_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.PILOT_DATABASE_URL = url;
  const repo = await import("../db/pilot/marking-repository.ts");
  const { pilotSql } = await import("../db/pilot/client.ts");
  const sql = pilotSql();

  // Seed an approved guide (impact 60, delivery 40) and 3 current applications
  // directly, since those repositories are built in a later step. Each call
  // makes a FRESH workspace so tests are isolated within the shared database.
  async function seed() {
    const [ws] = await sql`
      INSERT INTO netzero.workspaces (name, expected_marks_per_application)
      VALUES ('Net Zero 2026', 2) RETURNING id`;
    const eric = await repo.addReviewer(ws.id, "Eric");
    const trang = await repo.addReviewer(ws.id, "Trang");
    // Real flow: create the guide as a draft, add criteria, THEN approve it
    // (an approved guide and its criteria are frozen).
    const [guide] = await sql`
      INSERT INTO netzero.guide_versions
        (workspace_id, version, status, rules, selection_mode, shortlist_target, minimum_score, content_hash)
      VALUES (${ws.id}, 1, 'draft', '{}', 'both', 10, 70, ${"a".repeat(64)})
      RETURNING id`;
    await sql`
      INSERT INTO netzero.guide_criteria (guide_version_id, rule_id, title, weight, position)
      VALUES (${guide.id}, 'impact', 'Climate impact', 60, 0),
             (${guide.id}, 'delivery', 'Delivery', 40, 1)`;
    await sql`
      UPDATE netzero.guide_versions SET status='approved', approved_by=${eric.id}, approved_at=now()
       WHERE id=${guide.id}`;
    const [cd] = await sql`
      INSERT INTO netzero.current_datasets (workspace_id, name, fingerprint, case_count)
      VALUES (${ws.id}, 'Round 1', ${"b".repeat(64)}, 3) RETURNING id`;
    for (const rowId of ["app1", "app2", "app3"]) {
      await sql`INSERT INTO netzero.current_cases (dataset_id, row_id, answers) VALUES (${cd.id}, ${rowId}, '{}')`;
    }
    return { ws, eric, trang, guideId: guide.id };
  }

  async function mark(ctx, app, reviewer, impact, delivery) {
    await repo.upsertMark({
      workspaceId: ctx.ws.id, applicationRowId: app, reviewerId: reviewer,
      guideVersionId: ctx.guideId, ruleId: "impact", score: impact,
    });
    await repo.upsertMark({
      workspaceId: ctx.ws.id, applicationRowId: app, reviewerId: reviewer,
      guideVersionId: ctx.guideId, ruleId: "delivery", score: delivery,
    });
    return repo.submitMarkSet(ctx.ws.id, app, reviewer);
  }

  test.after(async () => { await sql.end({ timeout: 5 }); });

  test("ensureWorkspace is idempotent (get-or-create the single workspace)", async () => {
    const a = await repo.ensureWorkspace("Pilot", 2);
    const b = await repo.ensureWorkspace("Pilot", 2);
    assert.equal(a.id, b.id);
  });

  test("derives the weighted score from marks and the guide weights", async () => {
    const ctx = await seed();
    // impact 5/5 * 60 + delivery 3/5 * 40 = 60 + 24 = 84
    const submitted = await mark(ctx, "app1", ctx.eric.id, 5, 3);
    assert.equal(Number(submitted.weightedScore), 84);
  });

  test("a forged weighted_score is ignored - only the derived value counts", async () => {
    const ctx = await seed();
    // Try to write a fake score directly; the trigger recomputes it on submit.
    await repo.upsertMark({ workspaceId: ctx.ws.id, applicationRowId: "app2", reviewerId: ctx.eric.id, guideVersionId: ctx.guideId, ruleId: "impact", score: 1 });
    await repo.upsertMark({ workspaceId: ctx.ws.id, applicationRowId: "app2", reviewerId: ctx.eric.id, guideVersionId: ctx.guideId, ruleId: "delivery", score: 1 });
    await sql`UPDATE netzero.reviewer_mark_sets SET weighted_score = 999
              WHERE workspace_id=${ctx.ws.id} AND application_row_id='app2' AND reviewer_id=${ctx.eric.id}`;
    const submitted = await repo.submitMarkSet(ctx.ws.id, "app2", ctx.eric.id);
    assert.equal(Number(submitted.weightedScore), 20); // 1/5*60 + 1/5*40 = 20, not 999
  });

  test("full coverage: SUM ranking is valid and orders by total", async () => {
    const ctx = await seed();
    // Both reviewers mark all three; give app3 the highest, app2 lowest.
    await mark(ctx, "app1", ctx.eric.id, 5, 3); await mark(ctx, "app1", ctx.trang.id, 5, 3);   // 84+84=168
    await mark(ctx, "app2", ctx.eric.id, 2, 2); await mark(ctx, "app2", ctx.trang.id, 2, 2);   // 40+40=80
    await mark(ctx, "app3", ctx.eric.id, 5, 5); await mark(ctx, "app3", ctx.trang.id, 5, 5);   // 100+100=200
    const ranking = await repo.loadRanking(ctx.ws.id);
    const byRow = Object.fromEntries(ranking.map((r) => [r.rowId, r]));
    assert.equal(Number(byRow.app3.totalScore), 200);
    assert.equal(Number(byRow.app1.totalScore), 168);
    assert.equal(Number(byRow.app2.totalScore), 80);
    assert.equal(byRow.app3.rank, 1);
    assert.equal(byRow.app3.markCount, 2);
    assert.ok(ranking.every((r) => r.coverageComplete && r.rankingValid));
  });

  test("split workload: ranking_valid is FALSE (the coverage guard)", async () => {
    const ctx = await seed();
    // Eric marks app1 + app3; Trang marks app2. Each application has one mark.
    await mark(ctx, "app1", ctx.eric.id, 5, 5);
    await mark(ctx, "app3", ctx.eric.id, 5, 5);
    await mark(ctx, "app2", ctx.trang.id, 5, 5);
    const ranking = await repo.loadRanking(ctx.ws.id);
    assert.ok(ranking.every((r) => r.coverageComplete === false));
    assert.ok(ranking.every((r) => r.rankingValid === false));
    assert.ok(ranking.every((r) => r.markCount === 1));
  });

  test("a submitted mark set cannot be re-marked", async () => {
    const ctx = await seed();
    await mark(ctx, "app1", ctx.eric.id, 5, 3);
    await assert.rejects(
      repo.upsertMark({ workspaceId: ctx.ws.id, applicationRowId: "app1", reviewerId: ctx.eric.id, guideVersionId: ctx.guideId, ruleId: "impact", score: 1 }),
      /already submitted/i,
    );
  });

  test("submitting with a missing criterion is rejected", async () => {
    const ctx = await seed();
    await repo.upsertMark({ workspaceId: ctx.ws.id, applicationRowId: "app1", reviewerId: ctx.eric.id, guideVersionId: ctx.guideId, ruleId: "impact", score: 5 });
    await assert.rejects(
      repo.submitMarkSet(ctx.ws.id, "app1", ctx.eric.id),
      /every criterion must be marked/i,
    );
  });

  test("records a human final decision", async () => {
    const ctx = await seed();
    await repo.recordFinalDecision({ workspaceId: ctx.ws.id, applicationRowId: "app1", decision: "shortlisted", decidedBy: ctx.eric.id, notes: "strong" });
    const [d] = await sql`SELECT decision FROM netzero.final_decisions WHERE workspace_id=${ctx.ws.id} AND application_row_id='app1'`;
    assert.equal(d.decision, "shortlisted");
  });
}
