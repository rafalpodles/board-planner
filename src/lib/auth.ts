import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { User } from "@/models/user";
import { ApiToken } from "@/models/apiToken";
import { OAuthToken } from "@/models/oauthToken";
import { sha256 } from "./oauth";
import {
  ProvenanceError,
  checkProvenance,
  readSessionCookie,
  resolveSession,
} from "./session";
import { IUser } from "@/types";

export { getClientIp } from "./client-ip";

export const PASSWORD_COST_FACTOR = 10;
export const MIN_PASSWORD_LENGTH = 8;
const ABSENT_USER_HASH = bcrypt.hashSync("::no such user::", PASSWORD_COST_FACTOR);

export async function verifyCredentials(
  username: string,
  password: string
): Promise<IUser | null> {
  await connectDB();
  const user = await User.findOne({ username: username.toLowerCase() }).select(
    "+password"
  );

  if (!user) {
    await bcrypt.compare(password, ABSENT_USER_HASH);
    return null;
  }

  const valid = await bcrypt.compare(password, user.password);
  return valid ? user : null;
}

function applyTokenScope(user: IUser, scope: Types.ObjectId[]): IUser {
  user.instanceAdminBeforeScope = user.role === "admin";
  user.role = "member";
  user.tokenScope = scope;
  user.tokenScoped = true;
  return user;
}

async function verifyBearerToken(token: string): Promise<IUser | null> {
  await connectDB();

  const prefix = token.substring(0, 11);

  const candidates = await ApiToken.find({ prefix }).lean();

  for (const candidate of candidates) {
    const valid = await bcrypt.compare(token, candidate.tokenHash);
    if (valid) {
      ApiToken.findByIdAndUpdate(candidate._id, { lastUsedAt: new Date() }).catch(() => {});

      const user = await User.findById(candidate.user);
      if (!user) return null;

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
  const expiresAt = record.accessExpiresAt?.getTime();
  if (!Number.isFinite(expiresAt) || (expiresAt as number) < Date.now()) return null;

  const user = await User.findById(record.user);
  if (!user) return null;

  user.viaMachineCredential = true;
  const scope = record.allowedProjects || [];
  return scope.length > 0 ? applyTokenScope(user, scope) : user;
}

async function verifySessionCookie(request: Request): Promise<IUser | null> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (!token) return null;

  const provenance = checkProvenance(request);
  if (!provenance.ok) throw new ProvenanceError(provenance.reason);

  const session = await resolveSession(token);
  if (!session) return null;

  await connectDB();
  const user = await User.findById(session.userId);
  if (!user) return null;

  user.viaMachineCredential = false;
  user.sessionId = session.sessionId;
  return user;
}

export async function getAuthUser(
  request: Request
): Promise<IUser | null> {
  const authHeader = request.headers.get("authorization");

  if (authHeader && /^bearer /i.test(authHeader)) {
    const token = authHeader.slice(7);
    if (token.startsWith("cpat_")) {
      return verifyOAuthAccessToken(token);
    }
    if (token.startsWith("cp_")) {
      return verifyBearerToken(token);
    }
    return null;
  }

  return verifySessionCookie(request);
}
