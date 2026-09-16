import crypto from "crypto";

// On globalThis because instrumentation and the route handlers are separate module graphs in one
// process, and they must agree on the same generated code
const GENERATED = Symbol.for("board-planner.setup-code");

export function setupCode(): string {
  const configured = process.env.BOOTSTRAP_TOKEN?.trim();
  if (configured) return configured;

  const store = globalThis as unknown as Record<symbol, string | undefined>;
  if (!store[GENERATED]) {
    store[GENERATED] = crypto.randomBytes(16).toString("hex");
    console.warn(
      `No account exists yet. To create the first administrator, open /login and enter this setup code: ${store[GENERATED]}`
    );
  }
  return store[GENERATED]!;
}

export function setupCodeMatches(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate) return false;
  const expected = Buffer.from(setupCode());
  const given = Buffer.from(candidate.trim());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
