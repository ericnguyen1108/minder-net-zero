import assert from "node:assert/strict";
import test from "node:test";

import {
  decisionGuideSchema,
  hashDecisionGuide,
} from "../lib/decision-guide.ts";

function validGuide() {
  return {
    schemaVersion: 1,
    rules: [
      {
        id: "impact",
        kind: "criterion",
        title: "Net zero impact",
        statement: "Assess the quantified emissions impact claimed by the team.",
        passingCondition: "The claim identifies a baseline and measurable change.",
        evidence: "A baseline, calculation method and quantified result in the application.",
        sourceNote: "Competition rule 4",
        weight: 100,
        anchor1: "No quantified impact or baseline.",
        anchor3: "Plausible estimate with an identified baseline.",
        anchor5: "Verified result with method, baseline and material impact.",
      },
    ],
    eligibilityConfirmedNone: true,
    eliminationConfirmedNone: true,
    selection: { mode: "top_n", shortlistTarget: "20", minimumScore: "" },
    tieBreakPriority: ["impact"],
    clarificationPolicy: "not_allowed",
    missingInformationAcknowledged: true,
  };
}

test("a complete evidence-bound guide is accepted", () => {
  const result = decisionGuideSchema.safeParse(validGuide());
  assert.equal(result.success, true);
});

test("minimum-score selection uses the same 0–100 weighted scale as assessment results", () => {
  const content = validGuide();
  content.selection = { mode: "minimum_score", shortlistTarget: "", minimumScore: "70" };
  assert.equal(decisionGuideSchema.safeParse(content).success, true);
  content.selection.minimumScore = "101";
  assert.equal(decisionGuideSchema.safeParse(content).success, false);
});

test("guide approval fails closed on unsafe scoring and selection gaps", () => {
  const wrongWeight = validGuide();
  wrongWeight.rules[0].weight = 95;
  assert.equal(decisionGuideSchema.safeParse(wrongWeight).success, false);

  const missingAnchor = validGuide();
  missingAnchor.rules[0].anchor5 = "";
  assert.equal(decisionGuideSchema.safeParse(missingAnchor).success, false);

  const inventedTieBreak = validGuide();
  inventedTieBreak.tieBreakPriority = ["not-a-rule"];
  assert.equal(decisionGuideSchema.safeParse(inventedTieBreak).success, false);

  const impossibleTarget = validGuide();
  impossibleTarget.selection.shortlistTarget = "0";
  assert.equal(decisionGuideSchema.safeParse(impossibleTarget).success, false);
});

test("guide hashes are stable across object key order", async () => {
  const guide = decisionGuideSchema.parse(validGuide());
  const reordered = Object.fromEntries(Object.entries(guide).reverse());
  assert.equal(
    await hashDecisionGuide(guide),
    await hashDecisionGuide(reordered),
  );
});
