import { and, eq, inArray, sql } from "drizzle-orm";

import {
  applications,
  assessmentRuns,
  assignments,
  competitions,
  datasets,
  finalDecisionRevisions,
  guideVersions,
} from "../db/schema.ts";
import type { TenantTransaction } from "../db/tenant-transaction.ts";
import { permissionsForPrincipal, type ServerPrincipal } from "./auth/context.ts";

export type CompetitionOverview = {
  id: string;
  name: string;
  description: string;
  status: string;
  roles: readonly string[];
  permissions: readonly string[];
  guideApproved: boolean;
  historicalDataReady: boolean;
  currentDataReady: boolean;
  applications: number;
  assignments: number;
  submittedReviews: number;
  completedAssessmentRuns: number;
  finalDecisions: number;
};

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Returns operational counts only; no applicant identity or answer text. */
export async function loadCompetitionOverview(
  transaction: TenantTransaction,
  principal: ServerPrincipal,
): Promise<CompetitionOverview | null> {
  const [row] = await transaction
    .select({
      id: competitions.id,
      name: competitions.name,
      description: competitions.description,
      status: competitions.status,
      approvedGuides: sql<number>`(
        select count(*)::int from ${guideVersions}
        where ${guideVersions.tenantId} = ${principal.organizationId}
          and ${guideVersions.competitionId} = ${principal.competitionId}
          and ${guideVersions.status} = 'approved'
      )`,
      historicalDatasets: sql<number>`(
        select count(*)::int from ${datasets}
        where ${datasets.tenantId} = ${principal.organizationId}
          and ${datasets.competitionId} = ${principal.competitionId}
          and ${datasets.kind} = 'historical'
          and ${datasets.status} in ('ready', 'locked')
      )`,
      currentDatasets: sql<number>`(
        select count(*)::int from ${datasets}
        where ${datasets.tenantId} = ${principal.organizationId}
          and ${datasets.competitionId} = ${principal.competitionId}
          and ${datasets.kind} = 'current'
          and ${datasets.status} in ('ready', 'locked')
      )`,
      applicationCount: sql<number>`(
        select count(*)::int from ${applications}
        where ${applications.tenantId} = ${principal.organizationId}
          and ${applications.competitionId} = ${principal.competitionId}
          and ${applications.status} <> 'deleted'
      )`,
      assignmentCount: sql<number>`(
        select count(*)::int from ${assignments}
        where ${assignments.tenantId} = ${principal.organizationId}
          and ${assignments.competitionId} = ${principal.competitionId}
          and ${assignments.status} in ('assigned', 'in_progress', 'submitted')
      )`,
      submittedCount: sql<number>`(
        select count(*)::int from ${assignments}
        where ${assignments.tenantId} = ${principal.organizationId}
          and ${assignments.competitionId} = ${principal.competitionId}
          and ${assignments.status} = 'submitted'
      )`,
      completedRunCount: sql<number>`(
        select count(*)::int from ${assessmentRuns}
        where ${assessmentRuns.tenantId} = ${principal.organizationId}
          and ${assessmentRuns.competitionId} = ${principal.competitionId}
          and ${assessmentRuns.status} = 'completed'
      )`,
      finalDecisionCount: sql<number>`(
        select count(distinct ${finalDecisionRevisions.applicationId})::int
        from ${finalDecisionRevisions}
        where ${finalDecisionRevisions.tenantId} = ${principal.organizationId}
          and ${finalDecisionRevisions.competitionId} = ${principal.competitionId}
      )`,
    })
    .from(competitions)
    .where(
      and(
        eq(competitions.tenantId, principal.organizationId),
        eq(competitions.id, principal.competitionId),
        inArray(competitions.status, ["draft", "calibrating", "open", "reviewing", "decided"]),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    status: row.status,
    roles: principal.roles,
    permissions: permissionsForPrincipal(principal),
    guideApproved: integer(row.approvedGuides) > 0,
    historicalDataReady: integer(row.historicalDatasets) > 0,
    currentDataReady: integer(row.currentDatasets) > 0,
    applications: integer(row.applicationCount),
    assignments: integer(row.assignmentCount),
    submittedReviews: integer(row.submittedCount),
    completedAssessmentRuns: integer(row.completedRunCount),
    finalDecisions: integer(row.finalDecisionCount),
  };
}
