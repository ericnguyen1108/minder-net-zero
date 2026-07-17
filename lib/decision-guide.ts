import { z } from "zod";

export const guideRuleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  kind: z.enum(["eligibility", "elimination", "criterion"]),
  title: z.string().trim().min(2).max(200),
  statement: z.string().trim().min(5).max(4_000),
  passingCondition: z.string().trim().min(2).max(4_000),
  evidence: z.string().trim().min(2).max(4_000),
  sourceNote: z.string().trim().max(2_000).default(""),
  weight: z.number().int().min(0).max(100),
  anchor1: z.string().trim().max(2_000).default(""),
  anchor3: z.string().trim().max(2_000).default(""),
  anchor5: z.string().trim().max(2_000).default(""),
});

export const decisionGuideSchema = z.object({
  schemaVersion: z.literal(1),
  rules: z.array(guideRuleSchema).min(1).max(60),
  eligibilityConfirmedNone: z.boolean(),
  eliminationConfirmedNone: z.boolean(),
  selection: z.object({
    mode: z.enum(["top_n", "minimum_score", "both"]),
    shortlistTarget: z.string().trim().max(10),
    minimumScore: z.string().trim().max(20),
  }),
  tieBreakPriority: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/)).max(60),
  clarificationPolicy: z.enum(["allowed", "not_allowed"]),
  missingInformationAcknowledged: z.literal(true),
}).superRefine((guide, context) => {
  const ids = guide.rules.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Every rule needs a unique ID.", path: ["rules"] });
  }
  const criteria = guide.rules.filter((rule) => rule.kind === "criterion");
  if (criteria.length === 0) {
    context.addIssue({ code: "custom", message: "Add at least one scoring criterion.", path: ["rules"] });
  }
  const weight = criteria.reduce((sum, rule) => sum + rule.weight, 0);
  if (weight !== 100) {
    context.addIssue({ code: "custom", message: "Criterion weights must add up to 100.", path: ["rules"] });
  }
  for (const [index, rule] of guide.rules.entries()) {
    if (rule.kind !== "criterion" && rule.weight !== 0) {
      context.addIssue({ code: "custom", message: "Only scoring criteria have a weight.", path: ["rules", index, "weight"] });
    }
    if (rule.kind === "criterion" && (!rule.anchor1 || !rule.anchor3 || !rule.anchor5)) {
      context.addIssue({ code: "custom", message: "Each criterion needs 1, 3 and 5 score anchors.", path: ["rules", index] });
    }
  }
  const hasEligibility = guide.rules.some((rule) => rule.kind === "eligibility");
  const hasElimination = guide.rules.some((rule) => rule.kind === "elimination");
  if (!hasEligibility && !guide.eligibilityConfirmedNone) {
    context.addIssue({ code: "custom", message: "Confirm that there are no eligibility rules.", path: ["eligibilityConfirmedNone"] });
  }
  if (!hasElimination && !guide.eliminationConfirmedNone) {
    context.addIssue({ code: "custom", message: "Confirm that there are no elimination rules.", path: ["eliminationConfirmedNone"] });
  }
  if (new Set(guide.tieBreakPriority).size !== guide.tieBreakPriority.length ||
      guide.tieBreakPriority.some((id) => !ids.includes(id))) {
    context.addIssue({ code: "custom", message: "Tie-break priorities must reference unique existing rules.", path: ["tieBreakPriority"] });
  }
  if (guide.selection.mode === "top_n" || guide.selection.mode === "both") {
    const target = Number(guide.selection.shortlistTarget);
    if (!Number.isInteger(target) || target <= 0 || target > 10_000) {
      context.addIssue({ code: "custom", message: "Enter a valid shortlist size.", path: ["selection", "shortlistTarget"] });
    }
  }
  if (guide.selection.mode === "minimum_score" || guide.selection.mode === "both") {
    const minimum = Number(guide.selection.minimumScore);
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
      context.addIssue({ code: "custom", message: "Minimum score must be between 0 and 100.", path: ["selection", "minimumScore"] });
    }
  }
});

export type DecisionGuideContent = z.infer<typeof decisionGuideSchema>;

export function emptyDecisionGuide(): DecisionGuideContent {
  return {
    schemaVersion: 1,
    rules: [{
      id: crypto.randomUUID(),
      kind: "criterion",
      title: "",
      statement: "",
      passingCondition: "",
      evidence: "",
      sourceNote: "",
      weight: 100,
      anchor1: "",
      anchor3: "",
      anchor5: "",
    }],
    eligibilityConfirmedNone: false,
    eliminationConfirmedNone: false,
    selection: { mode: "top_n", shortlistTarget: "", minimumScore: "" },
    tieBreakPriority: [],
    clarificationPolicy: "not_allowed",
    missingInformationAcknowledged: true,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export async function hashDecisionGuide(guide: DecisionGuideContent): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stableValue(guide))),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
