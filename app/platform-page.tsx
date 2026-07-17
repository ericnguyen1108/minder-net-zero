import Link from "next/link";
import type { ReactNode } from "react";
import PlatformAccountMenu from "./platform-account-menu.tsx";

export default function PlatformPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="platform-page">
      <header className="platform-header">
        <Link className="platform-brand" href="/">
          <span className="brand-mark" aria-hidden="true">m<span /></span>
          <span><strong>Minder Net Zero</strong><small>Application review</small></span>
        </Link>
        <nav aria-label="Platform navigation">
          <Link href="/">Dashboard</Link>
          <Link href="/guide">Decision Guide</Link>
          <Link href="/applications">Applications</Link>
          <Link href="/admin/assignments">Assignments</Link>
          <Link href="/review">My reviews</Link>
          <Link href="/decisions">Decisions</Link>
          <Link href="/team">Team</Link>
          <Link href="/audit">Audit</Link>
        </nav>
        <PlatformAccountMenu />
      </header>
      <main className="platform-main">
        <div className="platform-title-row">
          <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
          <div className="platform-live-badge"><span />Shared live workspace</div>
        </div>
        {children}
      </main>
    </div>
  );
}
