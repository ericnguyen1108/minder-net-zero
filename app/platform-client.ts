export type CompetitionRole =
  | "owner"
  | "competition_admin"
  | "rubric_manager"
  | "reviewer"
  | "decision_approver"
  | "auditor";

export const ROLE_OPTIONS: Array<{ value: CompetitionRole; label: string; description: string }> = [
  { value: "competition_admin", label: "Competition admin", description: "Setup, imports, assignments and assessment runs" },
  { value: "rubric_manager", label: "Rubric manager", description: "Decision Guide, calibration and practice approval" },
  { value: "reviewer", label: "Reviewer", description: "Only applications specifically assigned to them" },
  { value: "decision_approver", label: "Decision approver", description: "Final decisions, overrides and approved exports" },
  { value: "auditor", label: "Auditor", description: "Read-only access to controls and audit history" },
];

export async function platformFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as
    | T
    | { error?: { message?: string; code?: string } }
    | null;
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new Error(error?.message ?? "The shared workspace could not be reached.");
  }
  return body as T;
}
