"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

export default function PlatformAccountMenu() {
  return (
    <div className="platform-account-menu" aria-label="Account and competition organization">
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl="/"
        appearance={{ elements: { rootBox: "platform-organization-switcher" } }}
      />
      <UserButton userProfileMode="modal" />
    </div>
  );
}
