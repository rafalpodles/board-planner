import { describe, it, expect } from "vitest";
import { childEnv, UNCONFINED_ESCAPE_HATCH, unconfinedAgentAllowed } from "./env.js";

const parent = {
  PATH: "/usr/bin",
  HOME: "/Users/owner",
  LANG: "en_GB.UTF-8",
  CP_API_TOKEN: "cp_secret",
  GH_TOKEN: "gho_secret",
  ANTHROPIC_API_KEY: "sk-secret",
  AWS_SECRET_ACCESS_KEY: "aws_secret",
  MONGODB_URI: "mongodb://user:pass@host/db",
  SOME_FUTURE_SECRET: "whatever",
};

describe("childEnv", () => {
  it("passes the variables a build actually needs", () => {
    expect(childEnv([], parent)).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      LANG: "en_GB.UTF-8",
    });
  });

  // The whole point: a denylist would have to name every secret that will ever exist
  it("carries no secret from the parent, including ones nobody thought to name", () => {
    const env = childEnv([], parent);

    expect(Object.values(env)).not.toContain("cp_secret");
    expect(env.CP_API_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.MONGODB_URI).toBeUndefined();
    expect(env.SOME_FUTURE_SECRET).toBeUndefined();
  });

  it("lets a caller name what it needs, so delivery can reach the ssh agent", () => {
    const env = childEnv(["GH_TOKEN"], parent);

    expect(env.GH_TOKEN).toBe("gho_secret");
    expect(env.CP_API_TOKEN).toBeUndefined();
  });

  it("omits an allowed variable the parent does not set, rather than passing undefined", () => {
    const env = childEnv([], { PATH: "/usr/bin" });

    expect(env).toEqual({ PATH: "/usr/bin" });
    expect("HOME" in env).toBe(false);
  });

  // BP-349. Whether the operator switched the sandbox off is the worker's business and not the
  // agent's: an agent that can read it knows whether an escape is worth attempting.
  it("does not tell the agent whether it is confined", () => {
    const env = childEnv([], { ...parent, [UNCONFINED_ESCAPE_HATCH]: "1" });

    expect(env[UNCONFINED_ESCAPE_HATCH]).toBeUndefined();
  });
});

describe("unconfinedAgentAllowed", () => {
  it("is false when the operator has said nothing", () => {
    expect(unconfinedAgentAllowed({})).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", " 1 "])("reads %o as the risk accepted", (value) => {
    expect(unconfinedAgentAllowed({ [UNCONFINED_ESCAPE_HATCH]: value })).toBe(true);
  });

  // "0" and "false" read as switching it off to anyone who has met an environment variable before,
  // and "" is what an unset variable looks like once a shell has exported it.
  it.each(["0", "false", "no", "", "  ", "maybe"])("does not read %o as an acceptance", (value) => {
    expect(unconfinedAgentAllowed({ [UNCONFINED_ESCAPE_HATCH]: value })).toBe(false);
  });
});
