import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagedModelsConfig,
  describeManagedModels,
  isManagedModel,
  managedModelWarnings,
  managedModelsFromEnv,
  openrouterModel,
  unmanagedModelError,
} from "./managed-models";

afterEach(() => {
  delete process.env.MANAGED_AI_MODELS;
});

// BP-1001
describe("the models the platform's key runs", () => {
  it("are OpenAI's own models by default, the PM and AI Assist defaults among them, and not gpt-oss, which OpenAI does not serve", () => {
    expect(isManagedModel("openai/gpt-6-luna")).toBe(true);
    expect(isManagedModel(openrouterModel("gpt-4o-mini"))).toBe(true);
    expect(isManagedModel("openai/gpt-4o")).toBe(true);
    expect(isManagedModel("openai/gpt-oss-120b")).toBe(false);
    expect(isManagedModel("moonshotai/kimi-k2.6")).toBe(false);
    expect(isManagedModel("anthropic/claude-haiku")).toBe(false);
    expect(isManagedModel("gpt-4o-mini")).toBe(false);
    expect(isManagedModel("xopenai/gpt-4o")).toBe(false);
  });

  it("are the operator's list where one is set: exact ids, and prefixes ending in *", () => {
    process.env.MANAGED_AI_MODELS = " openai/gpt-4o-mini , anthropic/claude-* ";

    expect(isManagedModel("openai/gpt-4o-mini")).toBe(true);
    expect(isManagedModel("openai/gpt-4o-mini-2")).toBe(false);
    expect(isManagedModel("openai/gpt-6-luna")).toBe(false);
    expect(isManagedModel("anthropic/claude-haiku")).toBe(true);
    expect(isManagedModel("anthropic/other")).toBe(false);
    expect(describeManagedModels()).toBe("openai/gpt-4o-mini, anthropic/claude-*");
  });

  it("fall back to the default for a value with no entries", () => {
    expect(managedModelsFromEnv("")).toEqual({ kind: "default" });
    expect(managedModelsFromEnv(" , ")).toEqual({ kind: "default" });
    expect(describeManagedModels()).toBe("OpenAI's own models (openai/…, not gpt-oss)");
  });

  it("stop the start for an entry that is not a model id or a prefix, naming it", () => {
    for (const bad of ["gpt-4o", "openai/", "*", "openai/gpt*4o", "openai/gpt 4o", "https://openrouter.ai/openai/gpt-4o"]) {
      process.env.MANAGED_AI_MODELS = `openai/gpt-4o-mini,${bad}`;
      expect(assertManagedModelsConfig, bad).toThrow(new RegExp(`^MANAGED_AI_MODELS must be .*got ${JSON.stringify(bad).replace(/[.*/]/g, "\\$&")}$`));
    }
    process.env.MANAGED_AI_MODELS = "openai/*,meta-llama/llama-3.1-8b-instruct:free";
    expect(assertManagedModelsConfig).not.toThrow();
  });

  it("are named in the refusal, with the organisation's own key as the other way", () => {
    expect(unmanagedModelError("openai/gpt-oss-120b")).toBe(
      "The model openai/gpt-oss-120b is not available on Board Planner's AI key. Choose one of: OpenAI's own models (openai/…, not gpt-oss), or add your organisation's own OpenRouter key in Settings → AI key."
    );
  });

  it("warn at boot on a hosted instance whose default PM model they would refuse, and nowhere else", () => {
    expect(managedModelWarnings(true, "moonshotai/kimi-k2.6")).toEqual([expect.stringMatching(/^WARNING: the default PM model moonshotai\/kimi-k2\.6 is not allowed/)]);
    expect(managedModelWarnings(true, "openai/gpt-6-luna")).toEqual([]);
    expect(managedModelWarnings(false, "moonshotai/kimi-k2.6")).toEqual([]);
  });
});
