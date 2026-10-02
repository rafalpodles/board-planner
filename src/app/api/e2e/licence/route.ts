import { NextResponse } from "next/server";
import { e2eOnlyMounted } from "@/lib/e2e-only";
import { setE2eLicenceKey } from "@/lib/licence";

// The dev server's LICENCE_KEY cannot change mid-run, and restarting it costs a Turbopack cold
// start per case; this swaps the key the server reads instead. Everything downstream — verifying,
// deriving the entitlements, the gate, the Settings page — is the path a real key takes.
export async function POST(request: Request) {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) {
    return new NextResponse(null, { status: 404 });
  }
  const { key } = (await request.json()) as { key?: unknown };
  if (key !== undefined && typeof key !== "string") {
    return NextResponse.json({ error: "key must be a string or absent" }, { status: 400 });
  }
  setE2eLicenceKey(key);
  return new NextResponse(null, { status: 204 });
}
