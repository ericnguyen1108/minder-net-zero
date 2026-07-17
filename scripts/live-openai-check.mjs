/**
 * Live connection check for the managed AI dependency.
 *
 * This does NOT touch any candidate data. It sends one tiny structured-output
 * request to the exact OpenAI Responses API endpoint, model, and payload shape
 * the app uses (see app/api/phase4/route.ts:callResponsesApi), so an
 * administrator can confirm the key and pinned model actually work before a
 * competition — the one thing the automated test suite cannot verify because it
 * mocks the network.
 *
 * Usage (the key stays in your shell; it is never printed):
 *   OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o node scripts/live-openai-check.mjs
 */

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "gpt-4o";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

if (!apiKey) {
  console.error("FAIL: OPENAI_API_KEY is not set. Export it in your shell and re-run.");
  process.exit(2);
}

const format = {
  type: "json_schema",
  name: "minder_live_check",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" }, echo: { type: "string", maxLength: 40 } },
    required: ["ok", "echo"],
  },
};

const body = JSON.stringify({
  model,
  store: false,
  instructions: "You are a connection check. Return the required structured object only.",
  input: 'Return {"ok": true, "echo": "minder-live-check"}.',
  max_output_tokens: 200,
  text: { format },
});

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

try {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
    signal: controller.signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    // Redact anything token-shaped before printing.
    const safe = detail.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").slice(0, 600);
    console.error(`FAIL: HTTP ${response.status} from OpenAI for model "${model}".`);
    console.error(safe);
    if (response.status === 401) console.error("→ The API key was rejected.");
    if (response.status === 404 || response.status === 400) {
      console.error(`→ Model "${model}" may not exist or not support the Responses API. Set OPENAI_MODEL to a real model.`);
    }
    process.exit(1);
  }

  const payload = await response.json();
  const text =
    payload.output_text ??
    payload.output?.flatMap((item) => item.content ?? []).find((part) => part?.type === "output_text")?.text ??
    "";
  console.log(`PASS: OpenAI responded for model "${model}".`);
  console.log(`Structured output: ${typeof text === "string" ? text.slice(0, 120) : JSON.stringify(payload).slice(0, 120)}`);
  process.exit(0);
} catch (error) {
  const timedOut = controller.signal.aborted;
  console.error(`FAIL: ${timedOut ? "request timed out after 30s" : `network error: ${String(error?.message ?? error)}`}.`);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}
