import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI as string);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  if (!db) {
    console.error("Failed to get database connection");
    process.exit(1);
  }

  let totalFixed = 0;
  const collections = await db.listCollections().toArray();

  for (const col of collections) {
    const collection = db.collection(col.name);
    const corrupted = await collection.find({ createdAt: { $type: "object" } }).toArray();

    for (const doc of corrupted) {
      const raw = doc.createdAt as Record<string, string> | undefined;
      const dateStr = raw?.$date;
      if (typeof dateStr === "string") {
        await collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(dateStr) } });
        totalFixed++;
      }
    }

    if (corrupted.length > 0) {
      console.log(`Fixed ${corrupted.length} corrupted date(s) in ${col.name}`);
    }
  }

  console.log(`Done. Total fixed: ${totalFixed}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
