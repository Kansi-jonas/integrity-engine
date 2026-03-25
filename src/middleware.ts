import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const p = request.nextUrl.pathname;
  if (p === "/api/health") return NextResponse.next();
  if (process.env.NODE_ENV === "development") return NextResponse.next();

  // API Key auth (for Wizard, customer dashboard, external consumers)
  const apiKey = process.env.API_KEY;
  if (apiKey && p.startsWith("/api/")) {
    const keyHeader = request.headers.get("x-api-key");
    if (keyHeader === apiKey) return NextResponse.next();
  }

  // Basic Auth (for dashboard UI)
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;
  if (!user || !pass) return NextResponse.next();

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = atob(encoded);
      const [u, p] = decoded.split(":");
      if (u === user && p === pass) return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="RTKdata Integrity"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
