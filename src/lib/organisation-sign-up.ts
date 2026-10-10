import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { PASSWORD_COST_FACTOR } from "./auth";
import { seedAgents } from "./agent-seed";
import { connectDB } from "./db";
import { scoped } from "./db-scope";
import { duplicateKeyField } from "./mongo-errors";
import { NAME_UNAVAILABLE, checkOrganisationName, nameIsReserved } from "./organisation";
import { RESERVED_SLUGS, forgetOrganisationSlugs, isSlug } from "./organisation-host";
import { purgeOrganisationRows } from "./organisation-life-cycle";
import { checkNewAccount, type NewAccountFields } from "./new-account";
import { logInstanceAudit } from "./instanceAudit";
import { checkTermsAccepted, type TermsAcceptance } from "./legal-terms";
import { Organisation } from "@/models/organisation";

export const SLUG_RULE = "An address is 3 to 40 lowercase letters, digits or hyphens, starting and ending with a letter or digit";
export const SLUG_UNAVAILABLE = "That address is not available. Try another.";

export type SignUpInput = {
  name?: unknown;
  slug?: unknown;
  username?: unknown;
  fullName?: unknown;
  password?: unknown;
  acceptTerms?: unknown;
};

export interface SignUp {
  name: string;
  slug: string;
  account: NewAccountFields;
  terms: TermsAcceptance;
}

export type SignUpOutcome =
  | { ok: true; organisation: Types.ObjectId; user: Types.ObjectId }
  | { ok: false; error: string };

export function checkSlug(value: unknown): { ok: true; slug: string } | { ok: false; error: string } {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!isSlug(slug)) return { ok: false, error: SLUG_RULE };
  if (RESERVED_SLUGS.includes(slug)) return { ok: false, error: SLUG_UNAVAILABLE };
  return { ok: true, slug };
}

export function checkSignUp(email: string, input: SignUpInput): { ok: true; value: SignUp } | { ok: false; error: string } {
  const name = checkOrganisationName(input.name);
  if (!name.ok) return { ok: false, error: name.error.replace(/^organisation/, "The organisation's name") };
  if (!name.value) return { ok: false, error: "Give the organisation a name" };
  if (nameIsReserved(name.value)) return { ok: false, error: NAME_UNAVAILABLE };
  const slug = checkSlug(input.slug);
  if (!slug.ok) return slug;
  const account = checkNewAccount({ username: input.username, fullName: input.fullName, email, password: input.password });
  if (!account.ok) return account;
  const terms = checkTermsAccepted(input.acceptTerms);
  if (!terms.ok) return terms;
  return { ok: true, value: { name: name.value, slug: slug.slug, account: account.value, terms: terms.fields } };
}

export async function slugTaken(slug: string): Promise<boolean> {
  await connectDB();
  return (await Organisation.countDocuments({ slug })) > 0;
}

export async function createOrganisation(signUp: SignUp): Promise<SignUpOutcome> {
  await connectDB();
  const password = await bcrypt.hash(signUp.account.password, PASSWORD_COST_FACTOR);
  const organisation = new Types.ObjectId();
  const creator = new Types.ObjectId();
  const organisationTerms = "termsAcceptedVersion" in signUp.terms ? { ...signUp.terms, termsAcceptedBy: creator } : {};
  try {
    await Organisation.create({ _id: organisation, name: signUp.name, slug: signUp.slug, ...organisationTerms });
  } catch (error) {
    if (duplicateKeyField(error) !== null) return { ok: false, error: SLUG_UNAVAILABLE };
    throw error;
  }

  try {
    const db = scoped(organisation);
    const user = await db.User.create({
      _id: creator,
      username: signUp.account.username,
      fullName: signUp.account.fullName,
      email: signUp.account.email,
      emailVerifiedAt: new Date(),
      password,
      role: "admin",
      kind: "human",
      ...signUp.terms,
    });
    await seedAgents(db);
    void logInstanceAudit(db, {
      action: "user_created",
      user: user._id,
      actorUsername: user.username,
      target: user.username,
      detail: `created the organisation ${signUp.slug} at sign-up`,
    });
    forgetOrganisationSlugs();
    return { ok: true, organisation, user: user._id };
  } catch (error) {
    await purgeOrganisationRows(organisation).catch(() => {});
    await Organisation.deleteOne({ _id: organisation }).catch(() => {});
    forgetOrganisationSlugs();
    throw error;
  }
}
