import { and, desc, eq, sql } from "drizzle-orm";

import { guideVersions } from "../db/schema.ts";
import type { TenantTransaction } from "../db/tenant-transaction.ts";
import type { ServerPrincipal } from "./auth/context.ts";
import {
  decisionGuideSchema,
  hashDecisionGuide,
  type DecisionGuideContent,
} from "./decision-guide.ts";

export type GuideSnapshotDto = {
  id: string;
  version: number;
  status: "draft" | "approved" | "retired";
  title: string;
  guide: DecisionGuideContent;
  createdAt: string;
  approvedAt: string | null;
};

export type GuideStateDto = {
  competitionId: string;
  latestVersion: number;
  latest: GuideSnapshotDto | null;
  approved: GuideSnapshotDto | null;
  history: Array<Omit<GuideSnapshotDto, "guide">>;
};

function snapshot(row: typeof guideVersions.$inferSelect): GuideSnapshotDto | null {
  const parsed = decisionGuideSchema.safeParse(row.body);
  if (!parsed.success) return null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    title: row.title,
    guide: parsed.data,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
  };
}

export async function loadGuideState(
  transaction: TenantTransaction,
  principal: ServerPrincipal,
): Promise<GuideStateDto> {
  const rows = await transaction
    .select()
    .from(guideVersions)
    .where(
      and(
        eq(guideVersions.tenantId, principal.organizationId),
        eq(guideVersions.competitionId, principal.competitionId),
        eq(guideVersions.kind, "rubric"),
      ),
    )
    .orderBy(desc(guideVersions.version))
    .limit(100);
  const snapshots = rows.map(snapshot).filter((item): item is GuideSnapshotDto => item !== null);
  return {
    competitionId: principal.competitionId,
    latestVersion: rows[0]?.version ?? 0,
    latest: snapshots[0] ?? null,
    approved: snapshots.find((item) => item.status === "approved") ?? null,
    history: snapshots.map((item) => ({
      id: item.id,
      version: item.version,
      status: item.status,
      title: item.title,
      createdAt: item.createdAt,
      approvedAt: item.approvedAt,
    })),
  };
}

export async function appendGuideSnapshot(
  transaction: TenantTransaction,
  input: {
    principal: ServerPrincipal;
    expectedLatestVersion: number;
    status: "draft" | "approved";
    title: string;
    guide: DecisionGuideContent;
    now: Date;
  },
): Promise<GuideSnapshotDto> {
  await transaction.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`${input.principal.competitionId}:rubric`}, 0))
  `);
  const state = await loadGuideState(transaction, input.principal);
  if (state.latestVersion !== input.expectedLatestVersion) throw new Error("revision_conflict");
  const version = state.latestVersion + 1;
  const [row] = await transaction
    .insert(guideVersions)
    .values({
      tenantId: input.principal.organizationId,
      competitionId: input.principal.competitionId,
      kind: "rubric",
      version,
      status: input.status,
      title: input.title,
      body: input.guide,
      contentHash: await hashDecisionGuide(input.guide),
      supersedesVersionId: state.latest?.id ?? null,
      approvedByUserId: input.status === "approved" ? input.principal.actorUserId : null,
      approvedAt: input.status === "approved" ? input.now : null,
      createdByUserId: input.principal.actorUserId,
      createdAt: input.now,
    })
    .returning();
  const result = snapshot(row);
  if (!result) throw new Error("invalid_snapshot");
  return result;
}
