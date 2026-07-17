import { SignIn } from "@clerk/nextjs";
import { platformConfiguration } from "../../../lib/platform-config.ts";
import ProductionSetupRequired from "../../production-setup-required.tsx";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  const config = platformConfiguration();
  if (config.authMode !== "clerk" || !config.clerkReady) {
    return <ProductionSetupRequired missing={config.missing} />;
  }

  return (
    <main className="clerk-sign-in-shell">
      <section className="clerk-sign-in-copy">
        <div className="brand-mark" aria-hidden="true">m<span /></div>
        <p className="eyebrow">Minder Net Zero</p>
        <h1>Evidence-led review, with people accountable for every decision.</h1>
        <p>Sign in with the individual account your competition administrator invited.</p>
        <div className="clerk-sign-in-safety">Invitation only · MFA protected · actions audited</div>
      </section>
      <SignIn routing="path" path="/sign-in" />
    </main>
  );
}
