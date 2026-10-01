import { type Instrumentation } from "next";
import { clientHungUp, describeRequestError } from "@/lib/request-error-log";

// Must live under src/, not at the repo root, even though Turbopack accepts either. The check that
// decides whether `standalone` output *packages* this file enumerates the app directory's parent —
// `src/` here — without recursing, so a root-level copy is invisible to it: the build succeeds, the
// chunk is emitted, and `.next/standalone` simply has no instrumentation.js. `next start` (Railway)
// still runs it; the Dockerfile, which copies only `.next/standalone`, silently boots without the
// PM scheduler or any seeding (BP-356).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootNode } = await import("./instrumentation-node");
    await bootNode();
  }
}

/**
 * Next calls this for every error a route handler or render lets escape. Without it the only trace
 * is the stack Next prints, which names neither the path nor the method — the gap that made BP-444
 * expensive to diagnose. Synchronous and console-only on purpose: an error reporter that awaits a
 * network call is one more thing to fail while something is already failing.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  if (clientHungUp(error)) {
    console.warn(`Client closed the connection mid-request — ${request.method} ${request.path.split("?")[0]}`);
    return;
  }
  console.error(describeRequestError(error, request, context));
};
