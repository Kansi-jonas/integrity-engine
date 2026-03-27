import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Timing-safe string comparison (prevents timing attacks on API keys)
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Public endpoints (no auth)
  if (pathname === "/api/health") return NextResponse.next();
  if (pathname.startsWith("/api/events")) return NextResponse.next(); // SSE
  if (process.env.NODE_ENV === "development") return NextResponse.next();

  // API Key auth (for service-to-service: Wizard, rtkbi, external consumers)
  const apiKey = process.env.API_KEY;
  if (apiKey && pathname.startsWith("/api/")) {
    const keyHeader = request.headers.get("x-api-key");
    if (keyHeader && timingSafeEqual(keyHeader, apiKey)) return NextResponse.next();
  }

  // Basic Auth (for dashboard UI)
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;

  // DEFAULT-DENY: If no auth is configured, block everything (not fail-open)
  if (!user || !pass) {
    return new NextResponse("Server not configured — set AUTH_USER and AUTH_PASS", { status: 503 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      try {
        const decoded = atob(encoded);
        const colonIdx = decoded.indexOf(":");
        if (colonIdx > 0) {
          const authUser = decoded.substring(0, colonIdx);
          const authPass = decoded.substring(colonIdx + 1);
          if (timingSafeEqual(authUser, user) && timingSafeEqual(authPass, pass)) {
            return NextResponse.next();
          }
        }
      } catch {}
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
