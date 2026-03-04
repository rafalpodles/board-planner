export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
