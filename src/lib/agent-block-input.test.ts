import { describe, it, expect } from "vitest";
import { fallbackForProviderRefusal, gateParams, modelForProviderRefusal, providerRefusal } from "./agent-block-input";

describe("providerRefusal", () => {
  it("takes a provider the catalog has, and an absent one", () => {
    expect(providerRefusal("claude")).toBeNull();
    expect(providerRefusal("codex")).toBeNull();
    expect(providerRefusal(undefined)).toBeNull();
  });

  it.each(["cursor", "", 7, null, "Codex"])("refuses %j", (value) => {
    expect(providerRefusal(value)).toMatch(/provider must be one of claude, codex/);
  });
});

describe("modelForProviderRefusal", () => {
  it("leaves a Claude step's model empty, which means the worker's own", () => {
    expect(modelForProviderRefusal("claude", "", "model")).toBeNull();
    expect(modelForProviderRefusal("claude", undefined, "model")).toBeNull();
  });

  it.each(["opus", "sonnet", "claude-opus-4-1", "haiku"])("takes %s on Claude", (model) => {
    expect(modelForProviderRefusal("claude", model, "model")).toBeNull();
  });

  it.each(["gpt-6.1-sol", "o4-mini", "codex-mini", "chatgpt-x"])("refuses %s on Claude and says to choose Codex", (model) => {
    expect(modelForProviderRefusal("claude", model, "model")).toMatch(/not a Claude model.*Codex/);
  });

  it("requires a model on Codex, because there is none that is right for every account", () => {
    expect(modelForProviderRefusal("codex", "", "model")).toMatch(/required for Codex/);
    expect(modelForProviderRefusal("codex", undefined, "model")).toMatch(/required for Codex/);
  });

  it.each(["gpt-6.1-sol", "gpt-5.6-luna", "o4-mini"])("takes %s on Codex", (model) => {
    expect(modelForProviderRefusal("codex", model, "model")).toBeNull();
  });

  it.each(["opus", "sonnet", "claude-opus-4-1", "Haiku"])("refuses %s on Codex", (model) => {
    expect(modelForProviderRefusal("codex", model, "model")).toMatch(/is a Claude model, not a Codex one/);
  });

  it("still refuses a name that is not one, on either provider", () => {
    expect(modelForProviderRefusal("codex", "gpt 5; rm -rf", "model")).toMatch(/must be a model name/);
    expect(modelForProviderRefusal("claude", "--model", "model")).toMatch(/must be a model name/);
  });
});

describe("fallbackForProviderRefusal", () => {
  it("allows a Claude fallback, and none", () => {
    expect(fallbackForProviderRefusal("claude", "sonnet")).toBeNull();
    expect(fallbackForProviderRefusal("claude", "")).toBeNull();
  });

  it("allows Codex no fallback at all, and does not ask for one", () => {
    expect(fallbackForProviderRefusal("codex", "")).toBeNull();
    expect(fallbackForProviderRefusal("codex", "gpt-5")).toMatch(/not used by Codex/);
  });
});

describe("gateParams for the review gate", () => {
  const review = (params: Record<string, unknown>) => gateParams("review", params);

  it("keeps the provider the kind declares, and drops what it does not", () => {
    expect(review({ provider: "codex", model: "gpt-5", focus: "security", junk: "x" }).params).toEqual({
      provider: "codex",
      model: "gpt-5",
      focus: "security",
    });
  });

  it("refuses an unknown reviewer", () => {
    expect(review({ provider: "cursor", model: "x" }).refusal).toMatch(/provider must be one of/);
  });

  it("refuses a Codex reviewer that names no model, and a pair that cannot exist", () => {
    expect(review({ provider: "codex" }).refusal).toMatch(/required for Codex/);
    expect(review({ provider: "codex", model: "opus" }).refusal).toMatch(/Claude model/);
    expect(review({ provider: "claude", model: "gpt-5" }).refusal).toMatch(/not a Claude model/);
  });

  it("takes a Claude reviewer with no provider named, as before", () => {
    expect(review({ model: "opus" }).refusal).toBeNull();
    expect(review({}).refusal).toBeNull();
  });
});
