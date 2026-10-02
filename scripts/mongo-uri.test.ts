import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUri } from "./mongo-uri";

const INTERNAL = "mongodb://mongo:secret@mongodb.railway.internal:27017";
const TUNNEL = "mongodb://mongo:secret@127.0.0.1:54321/?authSource=admin&directConnection=true";

function setEnv(vars: Partial<Record<"MONGODB_URI" | "MONGO_PUBLIC_URL" | "MONGO_URL" | "DATABASE_URL", string>>) {
  for (const name of ["MONGODB_URI", "MONGO_PUBLIC_URL", "MONGO_URL", "DATABASE_URL"] as const) {
    vi.stubEnv(name, vars[name] ?? "");
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("resolveUri", () => {
  it("takes the tunnel's MONGODB_URI over the internal MONGO_URL that railway run also injects", () => {
    setEnv({ MONGODB_URI: TUNNEL, MONGO_URL: INTERNAL });
    expect(resolveUri()).toEqual({ uri: TUNNEL, source: "MONGODB_URI" });
  });

  it("skips an internal MONGODB_URI for a reachable variable further down", () => {
    setEnv({ MONGODB_URI: INTERNAL, DATABASE_URL: TUNNEL });
    expect(resolveUri()).toEqual({ uri: TUNNEL, source: "DATABASE_URL" });
  });

  it("names the two-terminal tunnel when every URI is on the private network", () => {
    setEnv({ MONGO_URL: INTERNAL });
    let message = "";
    try {
      resolveUri();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("MONGO_URL point at Railway's private network");
    expect(message).toContain("1. railway connect MongoDB --tunnel-only");
    expect(message).toContain(
      `2. railway run --service MongoDB -- sh -c 'MONGODB_URI="mongodb://$MONGOUSER:$MONGOPASSWORD@127.0.0.1:<port>/?authSource=admin&directConnection=true" npx tsx scripts/<script>.ts ...'`
    );
    expect(message).not.toContain("exposes a public address");
  });

  it("asks for a variable when none is set", () => {
    setEnv({});
    expect(() => resolveUri()).toThrow("Set one of: MONGODB_URI, MONGO_PUBLIC_URL, MONGO_URL, DATABASE_URL");
  });
});
