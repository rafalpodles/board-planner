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

      // Caught here rather than left to the outer handler, which the deleted src/ copy of this
      // file did and this one did not: an instance without the catalog cannot run a worker but is
      // otherwise usable, and letting the failure through would skip the backfill and the PM
      // scheduler below it (BP-356).
      const { seedAgents } = await import("@/lib/agent-seed");
      await seedAgents().catch((error) => {
        console.error("Failed to seed the agent catalog:", error);
      });

      const { Agent } = await import("@/models/agent");
      const fallback = await Agent.findOne({ scope: "global", name: "Default" }, "_id").lean();
      if (fallback) {
        // A worker-enabled project with no agent would claim a task and then have nothing to run,
        // so the backfill has to reach every one of them, not only newly created ones.
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
