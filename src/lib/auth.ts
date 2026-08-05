import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { User } from "@/models/user";
import { ApiToken } from "@/models/apiToken";
import { OAuthToken } from "@/models/oauthToken";
import { sha256 } from "./oauth";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "./rate-limit";
import { IUser } from "@/types";

export class RateLimitError extends Error {
  constructor() {
    super("Too many failed attempts. Try again later.");
  }
}

export function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  // Rightmost entry is appended by the closest proxy; leftmost is client-controlled
  const parts = xff.split(",");
  return parts[parts.length - 1].trim() || "unknown";
}

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

// A token scoped to specific projects downgrades its bearer to member-level and records the
// scope on the principal; the intersection with the bearer's own grants is applied by
// decide() at every check. Empty scope = full inherit.
function applyTokenScope(user: IUser, scope: Types.ObjectId[]): IUser {
  user.instanceAdminBeforeScope = user.role === "admin";
  user.role = "member";
  user.tokenScope = scope;
  user.tokenScoped = true;
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

      // Every API token is a machine credential, scoped or not. tokenScoped answers a narrower
      // question — whether project access was narrowed — and an unscoped admin token leaves it
      // false, which is exactly the credential that must not reach the kill switch.
      user.viaMachineCredential = true;
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

  const user = await User.findById(record.user);
  if (!user) return null;

  // An OAuth access token is held by an application, not typed by a person at a keyboard
  user.viaMachineCredential = true;
  const scope = record.allowedProjects || [];
  return scope.length > 0 ? applyTokenScope(user, scope) : user;
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

  const rateKey = `${getClientIp(request)}:${creds.username.toLowerCase()}`;
  if (isRateLimited(rateKey)) {
    throw new RateLimitError();
  }

  const user = await verifyCredentials(creds.username, creds.password);
  if (user) {
    clearAttempts(rateKey);
  } else {
    recordFailedAttempt(rateKey);
  }
  return user;
}
