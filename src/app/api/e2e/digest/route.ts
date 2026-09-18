import { NextResponse } from "next/server";
import { digestTick } from "@/lib/digest";
import { e2eOnlyMounted } from "@/lib/e2e-only";

/**
 * Runs one digest tick now, so a spec can observe the morning message (BP-605).
 *
 * Nothing a person clicks produces a digest: `startDigestScheduler` fires it on a timer, at an
 * hour and in a timezone read from the environment. The suite pins that timer off
 * (`DIGEST_TICK_MS`) so it cannot land in the middle of somebody else's assertion, and asks for a
 * tick here instead.
 *
 * It runs in the dev server rather than in the Playwright worker on purpose. `@/lib/email` captures
 * `SMTP_*` at module load and one worker process shares its module registry across every spec in a
 * project, several of which import `@/lib/task-service` — which reaches `sendEmail` through
 * `in-app-notifications`. Importing the digest into the runner would arm real delivery for specs
 * that never asked for a mail server.
 *
 * 404 rather than 403 when it is not mounted: a refusal that names the route tells a caller it is
 * there.
 */
export async function POST() {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json({ sent: await digestTick() });
}
