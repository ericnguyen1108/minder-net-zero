import { resolveRequestPlatformContext } from "../../../lib/auth/request-context.ts";

import AssignmentAdmin from "./assignment-admin";

export const dynamic = "force-dynamic";

export default async function ReviewerAssignmentsPage() {
  const resolution = await resolveRequestPlatformContext();
  const competitions = resolution.ok
    ? resolution.context.competitions
        .filter((competition) => competition.permissions.includes("review.assign"))
        .map((competition) => ({ id: competition.id, name: competition.name }))
    : [];

  return <AssignmentAdmin competitions={competitions} />;
}
