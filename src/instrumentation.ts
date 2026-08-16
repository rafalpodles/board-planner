export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Read here so a fumbled value is one startup failure naming the variable, and so an operator
    // can see which answer the instance settled on — the throttle keys on it, and getting it wrong
    // is silent in both directions (BP-318)
    const { trustedProxyHops } = await import("@/lib/client-ip");
    const hops = trustedProxyHops();
    console.log(
      hops === 0
        ? "TRUSTED_PROXY_HOPS=0 — X-Forwarded-For is ignored and anonymous callers share one throttle bucket"
        : `TRUSTED_PROXY_HOPS=${hops} — the client address is taken ${hops} entries from the right of X-Forwarded-For`
    );

    const { connectDB } = await import("@/lib/db");
    try {
      const mongoose = await connectDB();
      console.log("MongoDB connected successfully");

      // Idempotent by $setOnInsert, so it is safe on every boot: it creates what is missing and
      // never overwrites a description somebody edited. Without this the catalog is empty, no
      // project has an agent to run, and every claim is released with nothing on the board to say
      // why — so its absence looks exactly like a worker that has no work.
      const { seedAgents } = await import("@/lib/agent-seed");
      await seedAgents().catch((error) => {
        // An instance without the catalog cannot run a worker, but is otherwise usable. Taking the
        // app down here would hide the reason rather than show it.
        console.error("Failed to seed the agent catalog:", error);
      });

      // Fix corrupted Extended JSON dates ({ $date: '...' } → native Date)
      const db = mongoose.connection.db;
      if (db) {
        const collections = await db.listCollections().toArray();
        for (const col of collections) {
          const collection = db.collection(col.name);
          const corrupted = await collection
            .find({ createdAt: { $type: "object" } })
            .toArray();
          for (const doc of corrupted) {
            const raw = doc.createdAt as Record<string, string> | undefined;
            const dateStr = raw?.$date;
            if (typeof dateStr === "string") {
              await collection.updateOne(
                { _id: doc._id },
                { $set: { createdAt: new Date(dateStr) } }
              );
            }
          }
          if (corrupted.length > 0) {
            console.log(
              `Fixed ${corrupted.length} corrupted dates in ${col.name}`
            );
          }
        }
      }
    } catch (err) {
      console.error("Failed to connect to MongoDB:", err);
      process.exit(1);
    }
  }
}
