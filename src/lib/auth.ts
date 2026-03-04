import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { User } from "@/models/user";
import { ApiToken } from "@/models/apiToken";
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

async function verifyBearerToken(token: string): Promise<IUser | null> {
  await connectDB();

  // Extract prefix for efficient lookup (first 11 chars: "cp_" + 8 hex)
  const prefix = token.substring(0, 11);

  // Find candidate tokens by prefix
  const candidates = await ApiToken.find({ prefix }).lean();

  for (const candidate of candidates) {
    const valid = await bcrypt.compare(token, candidate.tokenHash);
    if (valid) {
      // Update lastUsedAt (fire-and-forget)
      ApiToken.findByIdAndUpdate(candidate._id, { lastUsedAt: new Date() }).catch(() => {});

      const user = await User.findById(candidate.user);
      return user;
    }
  }

  return null;
}

export async function getAuthUser(
  request: Request
): Promise<IUser | null> {
  const authHeader = request.headers.get("authorization");

  // Try Bearer token first
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.startsWith("cp_")) {
      return verifyBearerToken(token);
    }
  }

  // Fall back to Basic Auth
  const creds = parseBasicAuth(authHeader);
  if (!creds) {
    return null;
  }

  return verifyCredentials(creds.username, creds.password);
}
