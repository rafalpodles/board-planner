import type { ScopedDb } from "@/lib/db-scope";
import { withAiMark } from "@/lib/pm/username";

export async function usernameOf(db: ScopedDb, userId: string): Promise<string> {
  const user = await db.User.findById(userId, "username").lean();
  return user?.username ?? "somebody";
}

/** How a sentence a person reads names somebody: their name, marked when it is the PM. */
export async function displayNameOf(db: ScopedDb, userId: string): Promise<string> {
  const user = await db.User.findById(userId, "username fullName").lean();
  if (!user) return "somebody";
  return withAiMark(user.fullName?.trim() || user.username, user.username);
}
