import { platformConfiguration } from "../../lib/platform-config.ts";
import PlatformPage from "../platform-page.tsx";
import ProductionSetupRequired from "../production-setup-required.tsx";
import AuditLog from "./audit-log.tsx";

export const dynamic = "force-dynamic";

export default function AuditPage() {
  const config = platformConfiguration();
  if (!config.ready || config.authMode !== "clerk") return <ProductionSetupRequired missing={config.missing.length ? config.missing : ["AUTH_MODE=clerk"]} />;
  return <PlatformPage eyebrow="Governance" title="Central audit log" description="A read-only history of access, rule approvals, imports, AI runs, reviewer work, overrides and exports."><AuditLog /></PlatformPage>;
}
