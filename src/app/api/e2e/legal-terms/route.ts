import { NextResponse } from "next/server";
import { e2eOnlyMounted } from "@/lib/e2e-only";
import { setE2eLegalTermsVersion } from "@/lib/legal-terms";

// LEGAL_TERMS_VERSION cannot change under a running dev server; this swaps the version it reads, absent restoring the variable
export async function POST(request: Request) {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) {
    return new NextResponse(null, { status: 404 });
  }
  const { version } = (await request.json()) as { version?: unknown };
  if (version !== undefined && typeof version !== "string") {
    return NextResponse.json({ error: "version must be a string or absent" }, { status: 400 });
  }
  setE2eLegalTermsVersion(version);
  return new NextResponse(null, { status: 204 });
}
