import { platformConfiguration } from "../../lib/platform-config.ts";
import PlatformPage from "../platform-page.tsx";
import ProductionSetupRequired from "../production-setup-required.tsx";
import GuideManager from "./guide-manager.tsx";

export const dynamic = "force-dynamic";

export default function GuidePage() {
  const config = platformConfiguration();
  if (!config.ready || config.authMode !== "clerk") {
    return <ProductionSetupRequired missing={config.missing.length ? config.missing : ["AUTH_MODE=clerk"]} />;
  }
  return (
    <PlatformPage
      eyebrow="Rules before AI"
      title="Decision Guide"
      description="Define the evidence, scoring and selection rules in plain language. Minder cannot use a draft until an authorised person approves an immutable version."
    >
      <GuideManager />
    </PlatformPage>
  );
}
