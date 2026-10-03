import crypto from "crypto";
import { NextResponse } from "next/server";
import { anonymousMultiplier, isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";

// On globalThis: instrumentation and route handlers are separate module graphs in one process
const GENERATED = Symbol.for("board-planner.setup-code");

export const MIN_BOOTSTRAP_TOKEN_LENGTH = 16;

export function setupCode(): string {
  const configured = process.env.BOOTSTRAP_TOKEN?.trim();
  if (configured && configured.length >= MIN_BOOTSTRAP_TOKEN_LENGTH) return configured;

  const store = globalThis as unknown as Record<symbol, string | undefined>;
  if (!store[GENERATED]) {
    store[GENERATED] = crypto.randomBytes(16).toString("hex");
    if (configured) {
      console.warn(
        `BOOTSTRAP_TOKEN is shorter than ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters and is ignored; a generated setup code is used instead.`
      );
    }
    console.warn(
      `No account exists yet. To create the first administrator, open /login and enter this setup code: ${store[GENERATED]}`
    );
  }
  return store[GENERATED]!;
}

// An operator's own token can be guessable, where a generated code is 128 random bits
export function setupCodeIsConfigured(): boolean {
  return (process.env.BOOTSTRAP_TOKEN?.trim().length ?? 0) >= MIN_BOOTSTRAP_TOKEN_LENGTH;
}

export function setupCodeMatches(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate) return false;
  const expected = Buffer.from(setupCode());
  const given = Buffer.from(candidate.trim());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * The gate in front of making the first account, whichever way it is made: a configured token is
 * throttled before it is compared, a generated code is checked first, so a stranger filling the
 * shared bucket cannot lock the operator out of an unguessable one. Null when the code is good.
 */
export async function refuseSetupCode(clientIp: string | null, candidate: unknown): Promise<NextResponse | null> {
  const throttleKey = sourceKey(clientIp ?? "-", "bootstrap");
  const throttled = () => isRateLimited(throttleKey, anonymousMultiplier(clientIp, 10));
  const tooMany = () =>
    NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  if (setupCodeIsConfigured() && (await throttled())) return tooMany();
  if (setupCodeMatches(candidate)) return null;
  if (await throttled()) return tooMany();
  await recordFailedAttempt(throttleKey);
  return NextResponse.json({ error: "The setup code is missing or wrong." }, { status: 403 });
}
