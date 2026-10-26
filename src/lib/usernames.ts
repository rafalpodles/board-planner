import type { ScopedDb } from "@/lib/db-scope";
import { withAiMark } from "@/lib/pm/username";

export async function usernameOf(db: ScopedDb, userId: string): Promise<string> {
  const user = await db.User.findById(userId, "username").lean();
  return user?.username ?? "somebody";
}

/** The handle machines key on, and how a sentence a person reads names them: their name, marked when it is the PM. */
export async function namesOf(db: ScopedDb, userId: string): Promise<{ username: string; displayName: string }> {
  const user = await db.User.findById(userId, "username fullName").lean();
  if (!user) return { username: "somebody", displayName: "somebody" };
  return { username: user.username, displayName: withAiMark(user.fullName?.trim() || user.username, user.username) };
}

export async function displayNameOf(db: ScopedDb, userId: string): Promise<string> {
  return (await namesOf(db, userId)).displayName;
}
