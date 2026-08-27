export const SENSITIVE_ASSESSMENT_HEADING_PATTERNS = [
  "^(?:(?:primary|secondary|main|alternate|applicant|founder|team|organisation|organization|company|emergency|billing|registered|postal|mailing|home|work)\\s+)?(?:contact\\s+)?(?:e\\s*mail(?:\\s+address)?|phone(?:\\s+number)?|mobile(?:\\s+number)?|address)$",
  "^(?:e\\s*mail(?:\\s+address)?|phone(?:\\s+number)?|mobile(?:\\s+number)?)(?:\\s+(?:of|for)\\s+(?:primary|secondary|main|alternate|applicant|founder|team(?:\\s+lead)?|organisation|organization|company|emergency|billing)(?:\\s+(?:contact|lead|representative|person))?)?$",
  "^(?:(?:registered|office|postal|mailing|home|work|business|residential|correspondence|company|organisation|organization)\\s+)?address(?:\\s+line\\s+\\d+)?$",
  "^(?:(?:primary|secondary|main|alternate|applicant|founder|team|organisation|organization|company|emergency)\\s+)?contact(?:\\s+(?:name|number|details?|person|e\\s*mail|address))?$",
  "\\b(?:passport|national\\s+id|social\\s+security|tax\\s+id|date\\s+of\\s+birth|dob|bank\\s+account|account\\s+number)\\b",
  "\\b(?:first|last|full|applicant|founder|member|reviewer|judge)\\s+name\\b",
  "\\bteam\\s+member\\s+names?\\b",
  "\\b(?:gender|sex|race|ethnicity|age|disability|religion|marital\\s+status|sexual\\s+orientation)\\b",
  "\\b(?:team|organisation|organization|company|venture|startup|project|applicant)\\s+name\\b",
  "\\b(?:application|submission|entry|applicant|team|project)\\s+(?:id|identifier|number)\\b",
  "^(?:id|name|team|organisation|organization|company)$",
  "^(?:(?:challenge|competition|application|submission|project)\\s+)?(?:track|category|theme)$",
  "\\b(?:historical|previous|prior|final)?\\s*(?:outcome|decision|result)\\b",
  "\\b(?:shortlist(?:ed)?|selected|rejected|winner|waitlist(?:ed)?|progressed|not\\s+progressed)\\b",
  "\\b(?:judge|reviewer|panel)(?:\\s+\\w+){0,2}\\s+(?:score|rating|rank|notes?|comments?|feedback)\\b",
  "\\b(?:total|final|weighted|judge|reviewer)\\s+(?:score|rating|rank)\\b",
] as const;

const SENSITIVE_ASSESSMENT_HEADINGS = SENSITIVE_ASSESSMENT_HEADING_PATTERNS.map(
  (source) => new RegExp(source, "i"),
);

function normalizedHeading(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isSensitiveAssessmentHeading(value: string) {
  const heading = normalizedHeading(value);
  return Boolean(heading) && SENSITIVE_ASSESSMENT_HEADINGS.some((pattern) => pattern.test(heading));
}
