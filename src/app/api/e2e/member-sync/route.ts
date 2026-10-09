import { NextResponse } from "next/server";
import { e2eOnlyMounted } from "@/lib/e2e-only";
import { runMemberSync } from "@/lib/member-sync";

/** Runs one member sync now, so a spec need not wait for the tick (BP-949). Closed outside the suite. */
export async function POST(request: Request) {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) return new NextResponse(null, { status: 404 });
  // The clock moved forward, so a run need not wait out the pause after a failure
  const { minutesFromNow = 0 } = (await request.json().catch(() => ({}))) as { minutesFromNow?: number };
  return NextResponse.json(await runMemberSync(Date.now() + minutesFromNow * 60 * 1000));
}
