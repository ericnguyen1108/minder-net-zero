import { platformConfiguration } from "../../lib/platform-config.ts";
import PlatformPage from "../platform-page.tsx";
import ProductionSetupRequired from "../production-setup-required.tsx";
import TeamManager from "./team-manager.tsx";

export const dynamic = "force-dynamic";

export default function TeamPage() {
  const config = platformConfiguration();
  if (!config.ready || config.authMode !== "clerk") {
    return <ProductionSetupRequired missing={config.missing.length ? config.missing : ["AUTH_MODE=clerk"]} />;
  }
  return (
    <PlatformPage
      eyebrow="People & permissions"
      title="Team and reviewer access"
      description="Invite each person individually and give them only the work they need. Access changes take effect centrally."
    >
      <TeamManager />
    </PlatformPage>
  );
}
