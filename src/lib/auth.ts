import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { User } from "@/models/user";
import { ApiToken } from "@/models/apiToken";
import { OAuthToken } from "@/models/oauthToken";
import { sha256 } from "./oauth";
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

// A token scoped to specific projects downgrades its bearer to member-level
// access limited to (scope ∩ owner's current access), enforced at every auth
// so all existing project-access checks honor it. Empty scope = full inherit.
function applyTokenScope(user: IUser, scope: Types.ObjectId[]): IUser {
  const effective =
    user.role === "admin"
      ? scope
      : (user.allowedProjects || []).filter((p) =>
          scope.some((s) => s.toString() === p.toString())
        );
  user.role = "member";
  user.allowedProjects = effective;
  return user;
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
      if (!user) return null;

      const scope = candidate.allowedProjects || [];
      return scope.length > 0 ? applyTokenScope(user, scope) : user;
    }
  }

  return null;
}

async function verifyOAuthAccessToken(token: string): Promise<IUser | null> {
  await connectDB();

  const record = await OAuthToken.findOne({ accessTokenHash: sha256(token) });
  if (!record) return null;
  if (record.accessExpiresAt.getTime() < Date.now()) return null;

  return User.findById(record.user);
}

export async function getAuthUser(
  request: Request
): Promise<IUser | null> {
  const authHeader = request.headers.get("authorization");

  // Try Bearer token first
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.startsWith("cpat_")) {
      return verifyOAuthAccessToken(token);
    }
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
