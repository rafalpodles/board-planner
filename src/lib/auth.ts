import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { User } from "@/models/user";
import { ApiToken } from "@/models/apiToken";
import { OAuthToken } from "@/models/oauthToken";
import { OAuthClient } from "@/models/oauthClient";
import { sha256 } from "./oauth";
import {
  ProvenanceError,
  checkProvenance,
  sessionCookieTokens,
  resolveSession,
} from "./session";
import { IUser } from "@/types";

// null, not a sentinel: a literal "unknown" collapses every caller on a proxy-less deployment into
// one identity, and a per-source refusal keyed on it becomes a way to lock a named user out.
// Callers must decide what to do with "no identity" rather than be handed a fake one.
// Lives in ./client-ip so the rule can be tested without the database this module needs.
export { getClientIp } from "./client-ip";

/**
 * A bcrypt hash of a value nobody can present, compared when the username does not exist.
 *
 * Without it the miss path returns in single-digit milliseconds while a hit pays ~100 ms, and the
 * difference needs no statistics to read: it is a username oracle on /api/auth/login and
 * /oauth/authorize (BP-318). Generated once at module load rather than written as a literal, so it
 * costs a real comparison — and at the factor stored passwords use, which is why that number has
 * one definition instead of three: raising it at the call sites and not here would quietly reopen
 * the gap with the suite green (BP-318 review).
 */
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
  // What makes a machine identity non-loginable, rather than trusting its password to be unknown
  return valid && user.kind !== "machine" ? user : null;
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
  // A row whose expiry is missing, null or unreadable is a credential that cannot be shown to be
  // live, and the bare `.getTime()` this replaces read both the wrong way: absent threw a TypeError
  // out of an ordinary refusal, and an unparseable date returned NaN — which is not less than
  // Date.now(), so the token was accepted. Number.isFinite is what says "shown to be live" rather
  // than "not shown to be expired" (BP-444).
  const expiresAt = record.accessExpiresAt?.getTime();
  if (!Number.isFinite(expiresAt) || (expiresAt as number) < Date.now()) return null;

  // The client's own deletion cascade (clients/route.ts) deletes this row's client last-but-one —
  // deliberately, so a concurrent grant's own existence check (token/route.ts) has something
  // reliable to read. But that ordering only closes the race at *issuance*; a token issued earlier
  // and still sitting in this collection stays readable here regardless of ordering if any one
  // step of that four-part, non-transactional cascade fails partway through. Checked here too, so
  // the cascade's ordering stops being the only thing standing between a deleted client and a
  // token that still verifies (BP-747 review).
  const clientStillExists = await OAuthClient.exists({ clientId: record.clientId });
  if (!clientStillExists) return null;

  const user = await User.findById(record.user);
  if (!user) return null;

  // An OAuth access token is held by an application, not typed by a person at a keyboard
  user.viaMachineCredential = true;
  const scope = record.allowedProjects || [];
  return scope.length > 0 ? applyTokenScope(user, scope) : user;
}

async function verifySessionCookie(request: Request): Promise<IUser | null> {
  const tokens = sessionCookieTokens(request.headers.get("cookie"));
  if (tokens.length === 0) return null;

  const provenance = checkProvenance(request);
  if (!provenance.ok) throw new ProvenanceError(provenance.reason);

  // One token: under auto the prefixed cookie wins whenever it is present, dead or alive, and the
  // plain name is read only when there is no prefixed cookie at all (BP-773 review).
  const session = await resolveSession(tokens[0]);
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

  // Case-insensitive to match mcp-handler, which lowercases the scheme before comparing: a
  // `bearer …` header would otherwise set its bearerToken while falling through to the cookie here
  if (authHeader && /^bearer /i.test(authHeader)) {
    const token = authHeader.slice(7);
    if (token.startsWith("cpat_")) {
      return verifyOAuthAccessToken(token);
    }
    if (token.startsWith("cp_")) {
      return verifyBearerToken(token);
    }
    // A presented Bearer that resolves to nothing must fail, not quietly fall back to the cookie:
    // /api/mcp gates on the header being present and would otherwise issue an AuthInfo for a token
    // it never validated, authenticated by a cookie that happened to ride along
    return null;
  }

  return verifySessionCookie(request);
}
