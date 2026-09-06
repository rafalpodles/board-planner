import { type Instrumentation } from "next";
import { describeRequestError } from "@/lib/request-error-log";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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

      const { seedAgents } = await import("@/lib/agent-seed");
      await seedAgents().catch((error) => {
        console.error("Failed to seed the agent catalog:", error);
      });

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
      console.error("Startup MongoDB connection failed (will retry on demand):", err);
    }
  }
}

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  console.error(describeRequestError(error, request, context));
};
