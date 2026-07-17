import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { platformAuthMode } from "./lib/platform-config.ts";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/api/webhooks/clerk(.*)",
  "/api/health(.*)",
]);

const productionMiddleware = clerkMiddleware(
  async (auth, request) => {
    if (!isPublicRoute(request)) await auth.protect();
  },
  {
    contentSecurityPolicy: {
      strict: true,
    },
  },
);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const mode = platformAuthMode();
  if (mode === "legacy") return NextResponse.next();
  if (mode !== "clerk") {
    return NextResponse.json(
      { error: { code: "platform_not_configured", message: "Secure account setup is incomplete." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return NextResponse.json(
      { error: { code: "platform_not_configured", message: "Secure account setup is incomplete." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return productionMiddleware(request, event);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    "/(api|trpc)(.*)",
  ],
};
