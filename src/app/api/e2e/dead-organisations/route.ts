import { NextResponse } from "next/server";
import { sweepDeadOrganisations } from "@/lib/dead-organisations";
import { e2eOnlyMounted } from "@/lib/e2e-only";

/**
 * Runs one dead-organisation sweep with the clock moved forward, so a spec can watch an organisation go
 * from noticed to suspended to deleted without waiting two months (BP-674). Closed outside the suite.
 */
export async function POST(request: Request) {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) {
    return new NextResponse(null, { status: 404 });
  }
  const { daysFromNow = 0, minutesFromNow = 0, days = 60 } = (await request.json().catch(() => ({}))) as { daysFromNow?: number; minutesFromNow?: number; days?: number };
  const now = Date.now() + daysFromNow * 24 * 60 * 60 * 1000 + minutesFromNow * 60 * 1000;
  return NextResponse.json(await sweepDeadOrganisations(now, days));
}
