export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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

      const { seedAgents } = await import("@/lib/agent-seed");
      await seedAgents();

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
    } catch (err) {
      // Don't crash the server on a transient boot-time DB hiccup;
      // route handlers reconnect lazily via connectDB().
      console.error("Startup MongoDB connection failed (will retry on demand):", err);
    }
  }
}
