import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { APP_NAME } from "@/lib/brand";
import { isEmailConfigured, isValidEmail, normaliseEmail, sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { sha256 } from "@/lib/oauth";
import { CODE_TTL_MS, startSignIn } from "@/lib/platform-sign-in";
import { refusedOffThePlatform, signInCookie } from "@/lib/platform-sign-in-route";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { provenanceRefusal } from "@/lib/session";

const CODES_PER_SOURCE = 20;
const CODES_PER_ADDRESS = 5;

const tooMany = () => NextResponse.json({ error: "Too many requests. Try again in 15 minutes." }, { status: 429 });

export async function POST(request: Request) {
  const offPlatform = await refusedOffThePlatform(request);
  if (offPlatform) return offPlatform;
  const refusal = provenanceRefusal(request);
  if (refusal) return refusal;

  const clientIp = getClientIp(request);
  const perSource = sourceKey(clientIp ?? "-", "platform-sign-in");
  if (await isRateLimited(perSource, anonymousMultiplier(clientIp, CODES_PER_SOURCE))) return tooMany();
  await recordFailedAttempt(perSource);

  const read = await readJsonBody<{ email?: unknown }>(request);
  if (!read.ok) return read.response;
  const email = typeof read.value.email === "string" ? normaliseEmail(read.value.email) : "";
  if (!isValidEmail(email)) return NextResponse.json({ error: "Enter a valid e-mail address" }, { status: 400 });

  if (!isEmailConfigured()) {
    return NextResponse.json({ error: "Sign-in by e-mail is unavailable: this service cannot send mail." }, { status: 503 });
  }

  const perAddress = `platform-sign-in:address:${sha256(email)}`;
  if (await isRateLimited(perAddress, CODES_PER_ADDRESS)) return tooMany();
  await recordFailedAttempt(perAddress);

  const { binder, code } = await startSignIn(email);
  void deliverCode(email, code);

  const response = NextResponse.json({ sent: true });
  response.headers.append("Set-Cookie", signInCookie(binder));
  return response;
}

async function deliverCode(email: string, code: string): Promise<void> {
  try {
    const minutes = Math.round(CODE_TTL_MS / 60_000);
    const { html, text } = renderEmail({
      preheader: `Your ${APP_NAME} code is ${code}.`,
      kicker: "Sign in",
      heading: `Your code is ${code}`,
      intro: [`Enter it on the sign-in page within ${minutes} minutes. It works once.`],
      outro: ["If you did not ask for it, ignore this message: nothing happens without the code."],
      footer: [`Sent because somebody entered ${email} on the ${APP_NAME} sign-in page.`],
    });
    const sent = await sendEmail({ to: email, subject: `${code} is your ${APP_NAME} code`, text, html });
    if (!sent) console.error("A sign-in code could not be sent");
  } catch (err) {
    console.error("Sign-in code delivery failed:", err);
  }
}
