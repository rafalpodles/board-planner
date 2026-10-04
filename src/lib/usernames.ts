import type { ScopedDb } from "@/lib/db-scope";

export async function usernameOf(db: ScopedDb, userId: string): Promise<string> {
  const user = await db.User.findById(userId, "username").lean();
  return user?.username ?? "somebody";
}
