import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import AccessGate from "./access-gate.tsx";
import { authIsConfigured, requestIsAuthorized } from "./auth.ts";
import { platformConfiguration } from "../lib/platform-config.ts";
import ProductionSetupRequired from "./production-setup-required.tsx";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const description = "A fair, evidence-backed application review workspace for net zero competitions.";

  return {
    metadataBase: baseUrl,
    title: "Minder Net Zero",
    description,
    openGraph: {
      title: "Minder Net Zero",
      description,
      type: "website",
      images: [{ url: new URL("/og.png", baseUrl).toString(), width: 1664, height: 948 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Minder Net Zero",
      description,
      images: [new URL("/og.png", baseUrl).toString()],
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const platform = platformConfiguration();

  if (platform.authMode === "clerk") {
    return (
      <ClerkProvider
        signInUrl="/sign-in"
        signUpUrl="/sign-in"
        afterSignOutUrl="/sign-in"
      >
        <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
          <body>
            {platform.ready ? children : <ProductionSetupRequired missing={platform.missing} />}
          </body>
        </html>
      </ClerkProvider>
    );
  }

  if (platform.authMode === "unconfigured") {
    return (
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
        <body><ProductionSetupRequired missing={platform.missing} /></body>
      </html>
    );
  }

  // Authorization trusts only the routing Host header, never x-forwarded-host,
  // which some proxy setups pass through from the client.
  const authorized = await requestIsAuthorized({
    hostHeader: requestHeaders.get("host"),
    cookieHeader: requestHeaders.get("cookie"),
  });

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{authorized ? children : <AccessGate configured={authIsConfigured()} />}</body>
    </html>
  );
}
