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
 * It runs in the dev server rather than in the Playwright worker, and the reason is not that the
 * import alone would do damage — it would do nothing at all. The runner has no `SMTP_*` (they are
 * set on the dev server, in `webServer[].env`), so `isEmailConfigured()` is false there and the
 * tick returns 0 on its first line. The hazard is in what making it work would take: `@/lib/email`
 * captures `SMTP_*` at module load, and one worker shares its registry across every spec in a
 * project — `claim-ownership`, `column-roles` and `worker-controls` already import
 * `@/lib/task-service`, which reaches `sendEmail` through `in-app-notifications`. Giving the runner
 * a mail server to run this one tick would arm real delivery for those too.
 *
 * What the refusal does and does not buy, measured rather than assumed. Next fills in the methods a
 * route module does not export, so on a deployment where this is shut `OPTIONS` still answers 204
 * with `Allow: OPTIONS, POST` and `GET` answers 405, where a path with no route at all answers 404.
 * The path is therefore discoverable whatever this handler returns — as it is anyway, from the
 * source of a public repository. What is closed is the effect: no tick runs, and nothing is sent.
 */
export async function POST() {
  if (!e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV)) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json({ sent: await digestTick() });
}
