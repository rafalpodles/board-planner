import { User } from "@/models/user";

export async function usernameOf(userId: string): Promise<string> {
  const user = await User.findById(userId, "username").lean();
  return user?.username ?? "somebody";
}
