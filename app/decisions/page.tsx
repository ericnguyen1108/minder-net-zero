import { platformConfiguration } from "../../lib/platform-config.ts";
import PlatformPage from "../platform-page.tsx";
import ProductionSetupRequired from "../production-setup-required.tsx";
import DecisionWorkspace from "./decision-workspace.tsx";

export const dynamic = "force-dynamic";

export default function DecisionsPage() {
  const config = platformConfiguration();
  if (!config.ready || config.authMode !== "clerk") {
    return <ProductionSetupRequired missing={config.missing.length ? config.missing : ["AUTH_MODE=clerk"]} />;
  }
  return (
    <PlatformPage
      eyebrow="Human accountability"
      title="Final decisions"
      description="Consider the evidence and reviewer recommendations, then record the authorised human outcome. Every revision remains in the audit history."
    >
      <DecisionWorkspace />
    </PlatformPage>
  );
}
