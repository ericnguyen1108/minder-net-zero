import { platformConfiguration } from "../../lib/platform-config.ts";
import PlatformPage from "../platform-page.tsx";
import ProductionSetupRequired from "../production-setup-required.tsx";
import ReviewQueue from "./review-queue.tsx";

export const dynamic = "force-dynamic";

export default function ReviewPage() {
  const config = platformConfiguration();
  if (!config.ready || config.authMode !== "clerk") return <ProductionSetupRequired missing={config.missing.length ? config.missing : ["AUTH_MODE=clerk"]} />;
  return <PlatformPage eyebrow="Reviewer workspace" title="My assigned applications" description="Each reviewer sees only their assigned submissions. Drafts, submissions and changes are attributed to the signed-in account."><ReviewQueue /></PlatformPage>;
}
