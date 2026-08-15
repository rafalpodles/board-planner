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
