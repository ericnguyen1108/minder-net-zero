import { platformConfiguration } from "../../lib/platform-config.ts";
import PlatformPage from "../platform-page.tsx";
import ProductionSetupRequired from "../production-setup-required.tsx";
import CurrentImportManager from "./current-import-manager.tsx";

export const dynamic = "force-dynamic";

export default function ApplicationsPage() {
  const config = platformConfiguration();
  if (!config.ready || config.authMode !== "clerk") {
    return <ProductionSetupRequired missing={config.missing.length ? config.missing : ["AUTH_MODE=clerk"]} />;
  }
  return (
    <PlatformPage
      eyebrow="Complete cohort"
      title="Import current applications"
      description="Choose the organiser spreadsheet, confirm which columns are identity and which are assessable answers, then publish the complete cohort to the shared database."
    >
      <CurrentImportManager />
    </PlatformPage>
  );
}
