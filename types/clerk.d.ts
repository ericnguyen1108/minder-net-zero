export {};

declare global {
  interface OrganizationPrivateMetadata {
    minderTenantId?: string;
  }

  interface OrganizationInvitationPrivateMetadata {
    minderCompetitionId?: string;
    minderRoles?: string[];
  }
}
