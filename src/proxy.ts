import { NextRequest, NextResponse } from "next/server";
import { NONCE_HEADER, REPORTING_ENDPOINTS, contentSecurityPolicy, generateNonce } from "@/lib/csp";

export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const policy = contentSecurityPolicy({ nonce, dev: process.env.NODE_ENV === "development" });

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
