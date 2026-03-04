/**
 * Migration script: ensures at least one admin user exists.
 * If no user has role "admin", promotes the oldest user.
 *
 * Usage: npx tsx scripts/ensure-admin.ts
 *
 * Requires MONGODB_URI environment variable.
 */

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

  const users = db.collection("users");

  // Check if any admin exists
  const adminCount = await users.countDocuments({ role: "admin" });

  if (adminCount > 0) {
    console.log(`Found ${adminCount} admin user(s). No migration needed.`);
    await mongoose.disconnect();
    return;
  }

  const totalUsers = await users.countDocuments();
  if (totalUsers === 0) {
    console.log("No users in database. First registered user will be admin.");
    await mongoose.disconnect();
    return;
  }

  // Find the oldest user
  const oldest = await users.findOne({}, { sort: { createdAt: 1 } });
  if (!oldest) {
    console.error("Could not find oldest user");
    await mongoose.disconnect();
    process.exit(1);
  }

  // Promote to admin
  await users.updateOne(
    { _id: oldest._id },
    { $set: { role: "admin" } }
  );

  console.log(
    `Promoted "${oldest.fullName}" (@${oldest.username}) to admin.`
  );

  // Set all other users without role to "member"
  const result = await users.updateMany(
    { role: { $exists: false } },
    { $set: { role: "member" } }
  );
  if (result.modifiedCount > 0) {
    console.log(`Set ${result.modifiedCount} user(s) to "member" role.`);
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
