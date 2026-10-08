import { NextResponse } from "next/server";
import { e2eOnlyMounted } from "@/lib/e2e-only";
import { runMemberSync } from "@/lib/member-sync";

/** Runs one member sync now, so a spec need not wait for the tick (BP-949). Closed outside the suite. */
export async function POST() {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) return new NextResponse(null, { status: 404 });
  return NextResponse.json(await runMemberSync());
}
