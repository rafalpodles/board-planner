import { describe, it, expect } from "vitest";
import { childEnv } from "./env.js";

const parent = {
  PATH: "/usr/bin",
  HOME: "/Users/rpo",
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
      HOME: "/Users/rpo",
      LANG: "en_GB.UTF-8",
    });
  });

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
});
