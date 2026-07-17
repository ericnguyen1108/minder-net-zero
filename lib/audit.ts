import { isServerPrincipal, type ServerPrincipal } from "./auth/context.ts";
import { isPlatformRole } from "./auth/roles.ts";

const SAFE_CODE = /^[a-z][a-z0-9_.-]{1,79}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/;
const SAFE_HASH = /^(?:[A-Fa-f0-9]{16,128}|[A-Za-z0-9_-]{20,200})$/;
const SAFE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const NON_NEGATIVE_NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  "recordCount",
  "resultCount",
  "durationMs",
  "attempt",
  "batchSize",
]);
const POSITIVE_NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  "revision",
  "expectedRevision",
  "actualRevision",
]);
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["conflict", "dryRun", "sealed"]);
const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  "requestId",
  "runId",
  "assessmentRunId",
  "batchId",
  "datasetId",
  "applicationId",
  "rubricVersionId",
  "guideVersionId",
  "idempotencyKey",
]);
const HASH_FIELDS: ReadonlySet<string> = new Set([
  "ipHash",
  "importHash",
  "fingerprint",
  "contractHash",
  "resultHash",
]);
const CODE_FIELDS: ReadonlySet<string> = new Set([
  "reasonCode",
  "source",
  "previousStatus",
  "nextStatus",
  "decisionCode",
  "errorCode",
  "exportFormat",
  "scope",
  "permission",
]);
const TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "userAgentFamily",
]);
const TOKEN_LIST_FIELDS: ReadonlySet<string> = new Set(["changedFields", "reasonCodes"]);

export type AuditOutcome = "success" | "denied" | "failed";
export type SafeAuditMetadataValue = string | number | boolean | readonly string[];
export type SafeAuditMetadata = Readonly<Record<string, SafeAuditMetadataValue>>;

export type CentralAuditEvent = Readonly<{
  id: string;
  organizationId: string;
  competitionId: string;
  actorUserId: string;
  actorRoles: readonly ServerPrincipal["role"][];
  actorRole: ServerPrincipal["role"];
  action: string;
  outcome: AuditOutcome;
  targetType: string;
  targetId: string;
  summaryCode: string;
  metadata: SafeAuditMetadata;
  occurredAt: string;
}>;

/**
 * Adapter implemented by the Postgres repository around the SAME transaction
 * as the domain mutation. This helper never opens an independent transaction,
 * so an audit insert failure causes the caller's mutation to roll back.
 */
export interface AuditTransaction {
  insertAuditEvent(event: CentralAuditEvent): Promise<void>;
}

export type AppendAuditEventInput = Readonly<{
  actor: ServerPrincipal;
  action: string;
  outcome: AuditOutcome;
  targetType: string;
  targetId: string;
  /** A machine code only, never a free-form sentence. */
  summaryCode: string;
  /**
   * Unknown fields and values outside strict structural allowlists are dropped.
   * Never pass candidate text here; pass IDs, counts, hashes, and state codes.
   */
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type AuditBuildDependencies = Readonly<{
  now?: () => Date;
  createId?: () => string;
}>;

function sanitizedRedactedFieldName(key: string): string {
  return SAFE_FIELD_NAME.test(key) ? key : "unknown";
}

function safeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) return null;
  return Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}

function safeString(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function safeRoleSet(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const roles = value.split("+");
  if (
    roles.length === 0 ||
    roles.length > 6 ||
    new Set(roles).size !== roles.length ||
    !roles.every(isPlatformRole)
  ) {
    return null;
  }
  return roles.join("+");
}

/**
 * Strict allowlist rather than a generic recursive redactor. A generic
 * redactor can miss a novel key; this function never persists unknown values.
 */
export function sanitizeAuditMetadata(
  input: Readonly<Record<string, unknown>> | null | undefined,
): SafeAuditMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) return Object.freeze({});

  const output: Record<string, SafeAuditMetadataValue> = {};
  const redactedFields = new Set<string>();
  const entries = Object.entries(input).slice(0, 100);

  for (const [key, value] of entries) {
    let sanitized: SafeAuditMetadataValue | null = null;
    if (NON_NEGATIVE_NUMERIC_FIELDS.has(key)) {
      const number = safeInteger(value);
      sanitized = number !== null && number >= 0 ? number : null;
    } else if (POSITIVE_NUMERIC_FIELDS.has(key)) {
      const number = safeInteger(value);
      sanitized = number !== null && number > 0 ? number : null;
    } else if (key === "httpStatus") {
      const number = safeInteger(value);
      sanitized = number !== null && number >= 100 && number <= 599 ? number : null;
    } else if (BOOLEAN_FIELDS.has(key)) {
      sanitized = typeof value === "boolean" ? value : null;
    } else if (IDENTIFIER_FIELDS.has(key)) {
      sanitized = safeString(value, SAFE_IDENTIFIER);
    } else if (HASH_FIELDS.has(key)) {
      sanitized = safeString(value, SAFE_HASH);
    } else if (CODE_FIELDS.has(key)) {
      sanitized = safeString(value, SAFE_CODE);
    } else if (TOKEN_FIELDS.has(key)) {
      sanitized = safeString(value, SAFE_TOKEN);
    } else if (key === "role") {
      sanitized = safeRoleSet(value);
    } else if (TOKEN_LIST_FIELDS.has(key) && Array.isArray(value)) {
      const pattern = key === "changedFields" ? SAFE_FIELD_NAME : SAFE_CODE;
      if (value.length <= 50) {
        const values = value
          .map((item) => safeString(item, pattern))
          .filter((item): item is string => item !== null);
        if (values.length === value.length) sanitized = Object.freeze(values);
      }
    }

    if (sanitized === null) {
      redactedFields.add(sanitizedRedactedFieldName(key));
    } else {
      output[key] = sanitized;
    }
  }

  if (Object.keys(input).length > entries.length) redactedFields.add("additionalFields");
  if (redactedFields.size > 0) {
    output.redactedFields = Object.freeze([...redactedFields].sort());
  }
  return Object.freeze(output);
}

function assertMachineCode(value: string, field: string): void {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) {
    throw new TypeError(`${field} must be a machine-readable code`);
  }
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
}

export function buildAuditEvent(
  input: AppendAuditEventInput,
  dependencies: AuditBuildDependencies = {},
): CentralAuditEvent {
  if (!isServerPrincipal(input.actor)) {
    throw new TypeError("actor must be derived from a verified server identity mapping");
  }
  assertMachineCode(input.action, "action");
  assertMachineCode(input.targetType, "targetType");
  assertMachineCode(input.summaryCode, "summaryCode");
  assertIdentifier(input.targetId, "targetId");
  if (input.outcome !== "success" && input.outcome !== "denied" && input.outcome !== "failed") {
    throw new TypeError("outcome is invalid");
  }

  const occurredAt = (dependencies.now ?? (() => new Date()))();
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
    throw new TypeError("audit timestamp is invalid");
  }
  const id = (dependencies.createId ?? (() => crypto.randomUUID()))();
  assertIdentifier(id, "id");

  return Object.freeze({
    id,
    organizationId: input.actor.organizationId,
    competitionId: input.actor.competitionId,
    actorUserId: input.actor.actorUserId,
    actorRoles: input.actor.roles,
    actorRole: input.actor.primaryRole,
    action: input.action,
    outcome: input.outcome,
    targetType: input.targetType,
    targetId: input.targetId,
    summaryCode: input.summaryCode,
    metadata: sanitizeAuditMetadata(input.metadata),
    occurredAt: occurredAt.toISOString(),
  });
}

export async function appendAuditEvent(
  transaction: AuditTransaction,
  input: AppendAuditEventInput,
  dependencies: AuditBuildDependencies = {},
): Promise<CentralAuditEvent> {
  if (!transaction || typeof transaction.insertAuditEvent !== "function") {
    throw new TypeError("a transaction-scoped audit writer is required");
  }
  const event = buildAuditEvent(input, dependencies);
  await transaction.insertAuditEvent(event);
  return event;
}
