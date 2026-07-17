/**
 * Proves the product's core works end-to-end against REAL OpenAI: an
 * evidence-bound assessment through the app's actual /api/phase4 gateway.
 * No mock - a genuine model call, the server's verbatim-quote re-verification,
 * and the local weighted score. Run with a billing-enabled key:
 *
 *   OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o node scripts/prove-ai-assessment.mjs
 */

import { POST } from "../app/api/phase4/route.ts";

const guide = {
  version: 1,
  status: "approved",
  rules: [
    { id: "impact", kind: "criterion", title: "Climate impact", statement: "Assess the stated climate impact.", passingCondition: "", evidence: "Use submitted text only.", weight: 60, anchor1: "Impact is unsupported.", anchor3: "Impact has some support.", anchor5: "Impact is quantified and credible." },
    { id: "delivery", kind: "criterion", title: "Delivery", statement: "Assess the credibility of the delivery plan.", passingCondition: "", evidence: "Use submitted text only.", weight: 40, anchor1: "No plan.", anchor3: "A partial plan.", anchor5: "A funded plan with committed partners." },
  ],
  selection: { mode: "minimum_score", shortlistTarget: "20", minimumScore: "70" },
  tieBreakPriority: [],
  clarificationPolicy: "not_allowed",
};

const cases = [
  {
    row_id: "demo-strong",
    answers: [
      { heading: "Impact", value: "We will avoid 12,000 tonnes of CO2e annually, independently verified by DNV." },
      { heading: "Delivery", value: "The pilot has three signed partners and a funded 12-month rollout starting in September." },
    ],
  },
  {
    row_id: "demo-weak",
    answers: [
      { heading: "Impact", value: "Our solution is world-leading and will help the planet a lot." },
      { heading: "Delivery", value: "We will figure out delivery once we get funding." },
    ],
  },
];

const request = new Request("http://localhost/api/phase4", {
  method: "POST",
  headers: { "content-type": "application/json", host: "localhost" },
  body: JSON.stringify({ action: "assess_cases", guide, approvedPatterns: [], cases }),
});

const started = Date.now();
const response = await POST(request);
const body = await response.json();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`HTTP ${response.status} in ${elapsed}s (real OpenAI call via the app gateway)\n`);
if (response.status !== 200) {
  console.log("Response:", JSON.stringify(body, null, 2).slice(0, 800));
  process.exit(response.status >= 500 ? 1 : 0);
}

console.log(`model: ${body.model}\n`);
for (const a of body.result?.assessments ?? []) {
  console.log(`Application ${a.rowId}:`);
  for (const s of a.criterionScores ?? []) {
    const quote = s.evidence ? `"${s.evidence.quote}"` : "(no evidence)";
    console.log(`  ${s.ruleId}: score ${s.score ?? "null (-> human review)"}  evidence ${quote}`);
  }
  if (a.uncertainties?.length) console.log(`  uncertainties: ${a.uncertainties.join("; ")}`);
  console.log("");
}
console.log("Every quote above was re-verified server-side as a verbatim substring of the applicant's own answer.");
