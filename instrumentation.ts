export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { connectDB } = await import("@/lib/db");
    try {
      await connectDB();
      console.log("MongoDB connected successfully");
    } catch (err) {
      // Don't crash the server on a transient boot-time DB hiccup;
      // route handlers reconnect lazily via connectDB().
      console.error("Startup MongoDB connection failed (will retry on demand):", err);
    }
  }
}
