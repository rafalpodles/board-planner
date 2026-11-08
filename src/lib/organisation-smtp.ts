import nodemailer, { type Transporter } from "nodemailer";
import type { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { scoped } from "@/lib/db-scope";
import { e2eOnlyMounted } from "@/lib/e2e-only";
import { decryptSecret } from "@/lib/encryption";
import { can } from "@/lib/entitlements";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import { isIpLiteral, unbracket } from "@/lib/private-address";
import { vettedAddress } from "@/lib/safe-fetch";
import { smtpTransportOptions } from "@/lib/smtp-transport";

export interface OwnMailServer {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

const SMTP_DESTINATION = { allowLoopback: e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV) };

export async function ownMailTransport(server: OwnMailServer): Promise<Transporter> {
  const host = unbracket(server.host);
  const address = await vettedAddress(host, SMTP_DESTINATION);
  return nodemailer.createTransport(
    smtpTransportOptions({
      host: address,
      port: server.port,
      user: server.user,
      pass: server.password,
      servername: isIpLiteral(host) ? undefined : host,
    })
  );
}

export const ownMailFrom = (server: Pick<OwnMailServer, "fromAddress" | "fromName">) =>
  server.fromName ? { name: server.fromName, address: server.fromAddress } : server.fromAddress;

const ROUTE_TTL_MS = 10_000;
const routes = new Map<string, { at: number; server: OwnMailServer | null }>();

export function forgetMailRoute(organisation?: Types.ObjectId): void {
  if (organisation) routes.delete(String(organisation));
  else routes.clear();
}

/**
 * The organisation's own mail server, while it is stored, readable and its plan includes it; otherwise null and the
 * mail goes through the platform's. Only the cloud has one.
 */
export async function ownMailServerFor(organisation: Types.ObjectId): Promise<OwnMailServer | null> {
  if (organisationDomain() === null) return null;
  const id = String(organisation);
  const seen = routes.get(id);
  if (seen && Date.now() - seen.at < ROUTE_TTL_MS) return seen.server;

  await connectDB();
  const [settings, row] = await Promise.all([scoped(organisation).Settings.findOne({}, "smtp").lean(), getOrganisation(organisation)]);
  const smtp = settings?.smtp;
  let server: OwnMailServer | null = null;
  if (smtp && can(row, "email.smtp")) {
    try {
      server = { ...smtp, fromName: smtp.fromName ?? "", password: decryptSecret(smtp.password, organisation) };
    } catch {
      console.error("The organisation's own mail server password cannot be read; its mail goes through the platform's server");
    }
  }
  routes.set(id, { at: Date.now(), server });
  return server;
}
