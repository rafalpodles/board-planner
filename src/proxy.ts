import { NextRequest, NextResponse } from "next/server";
import { NONCE_HEADER, REPORTING_ENDPOINTS, contentSecurityPolicy, generateNonce } from "@/lib/csp";

function isPrefetch(request: NextRequest): boolean {
  return request.headers.has("next-router-prefetch") || request.headers.get("purpose") === "prefetch";
}

export function proxy(request: NextRequest) {
  const dev = process.env.NODE_ENV === "development";

  // A prefetch is rendered ahead of any page that could use its nonce, so it gets none.
  if (isPrefetch(request)) {
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", contentSecurityPolicy({ dev }));
    response.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS);
    return response;
  }

  const nonce = generateNonce();
  const policy = contentSecurityPolicy({ nonce, dev });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS);
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
