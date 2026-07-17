export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

/** Process liveness only: deliberately performs no database or provider calls. */
export function GET() {
  return Response.json({ status: "ok" }, { status: 200, headers });
}

export function HEAD() {
  return new Response(null, { status: 200, headers });
}

