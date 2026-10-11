import { randomInt, timingSafeEqual } from "node:crypto";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { scoped, type ScopedDb } from "./db-scope";
import { normaliseEmail } from "./email";
import { randomToken, sha256 } from "./oauth";
import { acrossOrganisations } from "./organisation-wall";
import { organisationDomain, organisationOrigin } from "./organisation-host";
import { Organisation } from "@/models/organisation";
import { PlatformSignIn } from "@/models/platformSignIn";
import { User } from "@/models/user";

export const SIGN_IN_COOKIE = "bp_platform_signin";
export const REMEMBERED_ORGANISATION_COOKIE = "bp_last_organisation";
export const REMEMBERED_ORGANISATION_TTL_SECONDS = 180 * 24 * 60 * 60;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const VERIFIED_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const HANDOFF_TTL_MS = 60 * 1000;
export const CODE_DIGITS = 6;

const codeHash = (signIn: Types.ObjectId, code: string) => sha256(`${signIn}:${code}`);

export async function startSignIn(email: string): Promise<{ binder: string; code: string }> {
  await connectDB();
  const binder = randomToken("bps_");
  const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  const _id = new Types.ObjectId();
  await PlatformSignIn.create({
    _id,
    binderHash: sha256(binder),
    email: normaliseEmail(email),
    codeHash: codeHash(_id, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return { binder, code };
}

export type CodeVerdict = "verified" | "wrong" | "expired";

export async function verifySignInCode(binder: string, code: string): Promise<CodeVerdict> {
  await connectDB();
  const now = new Date();
  const row = await PlatformSignIn.findOneAndUpdate(
    { binderHash: sha256(binder), verifiedAt: null, expiresAt: { $gt: now }, attempts: { $lt: MAX_CODE_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" }
  ).lean();
  if (!row) return "expired";

  const expected = Buffer.from(row.codeHash);
  const given = Buffer.from(codeHash(row._id, code.trim()));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "wrong";

  const verified = await PlatformSignIn.updateOne(
    { _id: row._id, verifiedAt: null },
    { $set: { verifiedAt: now, expiresAt: new Date(now.getTime() + VERIFIED_TTL_MS) } }
  );
  return verified.modifiedCount === 1 ? "verified" : "expired";
}

export async function verifiedEmail(binder: string | null): Promise<string | null> {
  if (!binder) return null;
  await connectDB();
  const row = await PlatformSignIn.findOne({
    binderHash: sha256(binder),
    verifiedAt: { $ne: null },
    expiresAt: { $gt: new Date() },
  }).lean();
  return row?.email ?? null;
}

export async function claimProof(binder: string | null): Promise<string | null> {
  if (!binder) return null;
  await connectDB();
  const row = await PlatformSignIn.findOneAndUpdate(
    { binderHash: sha256(binder), verifiedAt: { $ne: null }, claimedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { claimedAt: new Date() } },
    { returnDocument: "after" }
  ).lean();
  return row?.email ?? null;
}

export async function releaseProof(binder: string | null): Promise<void> {
  if (!binder) return;
  await connectDB();
  await PlatformSignIn.updateOne({ binderHash: sha256(binder) }, { $set: { claimedAt: null } });
}

export async function endSignIn(binder: string | null): Promise<void> {
  if (!binder) return;
  await connectDB();
  await PlatformSignIn.deleteOne({ binderHash: sha256(binder) });
}

const provenAccount = (email: string) => ({
  email: normaliseEmail(email),
  emailVerifiedAt: { $ne: null },
  emailVouchedByAdmin: { $ne: true },
  kind: { $ne: "machine" as const },
  deactivatedAt: null,
});

export interface PlatformOrganisation {
  id: string;
  name: string;
  slug: string | null;
  origin: string;
}

const servedOrganisation = { suspendedAt: null, deletingAt: null, deletedAt: null };

export async function organisationsFor(email: string): Promise<PlatformOrganisation[]> {
  await connectDB();
  const accounts = await acrossOrganisations(
    User.find({ ...provenAccount(email) }).select("organisation").lean(),
    "an address proven on the platform host is shown where it has accounts"
  );
  const ids = [...new Set(accounts.map((account) => String(account.organisation)))].map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return [];

  const rows = await Organisation.find({ _id: { $in: ids }, ...servedOrganisation }).select("name slug").sort({ name: 1 }).collation({ locale: "en", strength: 2 }).lean();
  const listed = await Promise.all(
    rows.map(async (row) => {
      const origin = await organisationOrigin(row._id);
      return origin && onThePlatformsSite(origin) ? { id: String(row._id), name: row.name, slug: row.slug ?? null, origin } : null;
    })
  );
  return listed.filter((row): row is PlatformOrganisation => row !== null);
}

function onThePlatformsSite(origin: string): boolean {
  const domain = organisationDomain();
  return !!domain && new URL(origin).hostname.endsWith(`.${domain}`);
}

export async function servedOrganisationById(id: unknown): Promise<PlatformOrganisation | null> {
  if (typeof id !== "string" || !Types.ObjectId.isValid(id) || id.length !== 24) return null;
  await connectDB();
  const row = await Organisation.findOne({ _id: new Types.ObjectId(id), ...servedOrganisation }).select("name slug").lean();
  if (!row) return null;
  const origin = await organisationOrigin(row._id);
  return origin && onThePlatformsSite(origin) ? { id: String(row._id), name: row.name, slug: row.slug ?? null, origin } : null;
}

export async function accountByEmail(db: ScopedDb, email: string) {
  return db.User.findOne(provenAccount(email))
    .select("_id username")
    .lean();
}

export async function issueHandoff(db: ScopedDb, user: Types.ObjectId): Promise<string> {
  const code = randomToken("bph_");
  await db.HandoffCode.create({ codeHash: sha256(code), user, expiresAt: new Date(Date.now() + HANDOFF_TTL_MS) });
  return code;
}

export async function spendHandoff(db: ScopedDb, code: string): Promise<Types.ObjectId | null> {
  await connectDB();
  const now = new Date();
  const spent = await db.HandoffCode.findOneAndUpdate(
    { codeHash: sha256(code), spentAt: null, expiresAt: { $gt: now } },
    { $set: { spentAt: now } },
    { returnDocument: "after" }
  ).lean();
  return spent ? (spent.user as Types.ObjectId) : null;
}

export const scopedToOrganisation = (organisation: PlatformOrganisation): ScopedDb => scoped(new Types.ObjectId(organisation.id));
