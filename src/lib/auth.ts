import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { User } from "@/models/user";
import { IUser } from "@/types";

export function parseBasicAuth(
  header: string | null
): { username: string; password: string } | null {
  if (!header || !header.startsWith("Basic ")) {
    return null;
  }

  const base64 = header.slice(6);
  const decoded = Buffer.from(base64, "base64").toString("utf-8");
  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

export async function verifyCredentials(
  username: string,
  password: string
): Promise<IUser | null> {
  await connectDB();
  const user = await User.findOne({ username: username.toLowerCase() }).select(
    "+password"
  );

  if (!user) {
    return null;
  }

  const valid = await bcrypt.compare(password, user.password);
  return valid ? user : null;
}

export async function getAuthUser(
  request: Request
): Promise<IUser | null> {
  const creds = parseBasicAuth(request.headers.get("authorization"));
  if (!creds) {
    return null;
  }

  return verifyCredentials(creds.username, creds.password);
}
