import { type Instrumentation } from "next";
import { describeRequestError } from "@/lib/request-error-log";

// Must live under src/, not at the repo root, even though Turbopack accepts either. The check that
// decides whether `standalone` output *packages* this file enumerates the app directory's parent —
// `src/` here — without recursing, so a root-level copy is invisible to it: the build succeeds, the
// chunk is emitted, and `.next/standalone` simply has no instrumentation.js. `next start` (Railway)
// still runs it; the Dockerfile, which copies only `.next/standalone`, silently boots without the
// PM scheduler or any seeding (BP-356).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Read here so a fumbled value is one startup failure naming the variable, and so an operator
    // can see which answer the instance settled on — the throttle keys on it, and getting it wrong
    // is silent in both directions (BP-318). This lived in a second copy of this file under src/
    // that Next never loaded, so it had never once been printed (BP-356).
    const { trustedProxyHops } = await import("@/lib/client-ip");
    const hops = trustedProxyHops();
    console.log(
      hops === 0
        ? "TRUSTED_PROXY_HOPS=0 — X-Forwarded-For is ignored and anonymous callers share one throttle bucket"
        : `TRUSTED_PROXY_HOPS=${hops} — the client address is taken ${hops} entries from the right of X-Forwarded-For`
    );

    const { connectDB } = await import("@/lib/db");
    try {
      await connectDB();
      console.log("MongoDB connected successfully");

      const { Project } = await import("@/models/project");
      const { DEFAULT_PROJECT_CATEGORIES, DEFAULT_PROJECT_COLUMNS } = await import("@/types");
      const seeded = await Project.updateMany(
        { categories: { $exists: false } },
        { $set: { categories: DEFAULT_PROJECT_CATEGORIES } }
      );
      if (seeded.modifiedCount > 0) {
        console.log(`Seeded default categories on ${seeded.modifiedCount} project(s)`);
      }
      const seededColumns = await Project.updateMany(
        { columns: { $exists: false } },
        { $set: { columns: DEFAULT_PROJECT_COLUMNS } }
      );
      if (seededColumns.modifiedCount > 0) {
        console.log(`Seeded default columns on ${seededColumns.modifiedCount} project(s)`);
      }

      // Caught here rather than left to the outer handler: the backfill and the PM scheduler are
      // below this line, so an unhandled seed failure would skip both — and be logged as a
      // connection problem, which it is not. An instance without the catalog cannot run a worker
      // but is otherwise usable.
      const { seedAgents } = await import("@/lib/agent-seed");
      await seedAgents().catch((error) => {
        console.error("Failed to seed the agent catalog:", error);
      });

      const { Agent } = await import("@/models/agent");
      const fallback = await Agent.findOne({ scope: "global", name: "Default" }, "_id").lean();
      if (fallback) {
        // worker.agent is no longer a claim-time fallback — BP-358 made snapshotFor stop reading
        // Project. Its job now is the agent the task picker offers first on a new task, which a
        // later change wires up. The backfill still has to reach every project, not only newly
        // created ones, so that suggestion points at a real agent everywhere.
        const backfilled = await Project.updateMany(
          { "worker.agent": { $in: [null, undefined] } },
          { $set: { "worker.agent": fallback._id } }
        );
        if (backfilled.modifiedCount > 0) {
          console.log(`Backfilled the default agent on ${backfilled.modifiedCount} project(s)`);
        }
      }

      const { startPmScheduler } = await import("@/lib/pm/scheduler");
      startPmScheduler();
      console.log("PM scheduler started");

      const { startDigestScheduler, digestHour, digestTimezone } = await import("@/lib/digest");
      const { isEmailConfigured } = await import("@/lib/email");
      if (isEmailConfigured()) {
        startDigestScheduler();
        console.log(`Digest scheduler started — ${digestHour()}:00 ${digestTimezone()}`);
      }
    } catch (err) {
      // Don't crash the server on a transient boot-time DB hiccup;
      // route handlers reconnect lazily via connectDB().
      console.error("Startup MongoDB connection failed (will retry on demand):", err);
    }
  }
}

/**
 * Next calls this for every error a route handler or render lets escape. Without it the only trace
 * is the stack Next prints, which names neither the path nor the method — the gap that made BP-444
 * expensive to diagnose. Synchronous and console-only on purpose: an error reporter that awaits a
 * network call is one more thing to fail while something is already failing.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  console.error(describeRequestError(error, request, context));
};
