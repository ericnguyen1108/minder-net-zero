import assert from "node:assert/strict";
import test from "node:test";

import { isSensitiveAssessmentHeading } from "../app/assessment-safety.ts";

test("allows application questions that use contact words as ordinary language", () => {
  for (const heading of [
    "How does your solution address climate change?",
    "How will you contact potential customers?",
    "Describe the mobile technology used by your solution",
  ]) {
    assert.equal(isSensitiveAssessmentHeading(heading), false, heading);
  }
});

test("continues to block explicit contact, identity and protected-characteristic fields", () => {
  for (const heading of [
    "Email address",
    "Contact email address",
    "Email of primary contact",
    "Phone number",
    "Phone number for team lead",
    "Company address",
    "Office address line 1",
    "Gender",
    "Team name",
    "Application ID",
    "Reviewer notes",
  ]) {
    assert.equal(isSensitiveAssessmentHeading(heading), true, heading);
  }
});
