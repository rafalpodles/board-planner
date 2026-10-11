import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedDb } from "@/lib/db-scope";

const { modelsRestricted, listCatalogue, getOrganisation, can } = vi.hoisted(() => ({
  modelsRestricted: vi.fn(),
  listCatalogue: vi.fn(),
  getOrganisation: vi.fn(),
  can: vi.fn(),
}));

vi.mock("@/lib/model-keys", () => ({ modelsRestricted }));
vi.mock("@/lib/openrouter-catalogue", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/openrouter-catalogue")>()), listCatalogue }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("@/lib/entitlements", () => ({ can }));

const { refuseModel, modelsLostWithOwnKey } = await import("./model-check");

let projects: { pm?: { model?: string } }[] = [];
let saved: { aiModel?: string } | null = null;
const db = {
  organisation: "org-1",
  Project: { find: () => ({ lean: async () => projects }) },
  Settings: { findOne: () => ({ lean: async () => saved }) },
} as unknown as ScopedDb;

const CATALOGUE = ["openai/gpt-4o-mini", "openai/gpt-6-luna", "openai/gpt-oss-120b", "anthropic/claude-haiku-5.5"].map((id) => ({ id, name: id }));

beforeEach(() => {
  vi.clearAllMocks();
  projects = [];
  saved = { aiModel: "openai/gpt-6-luna" };
  modelsRestricted.mockResolvedValue(true);
  listCatalogue.mockResolvedValue(CATALOGUE);
  getOrganisation.mockResolvedValue({});
  can.mockReturnValue(true);
});

afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
  delete process.env.OPENROUTER_API_KEY;
});

// BP-1024
describe("a model that is saved", () => {
  it("is refused on a key that runs only the allowed providers' models, with the refusal the call would give", async () => {
    expect(await refuseModel(db, "anthropic/claude-haiku-5.5")).toBe(
      "The model anthropic/claude-haiku-5.5 is not available on Board Planner's AI key. Choose one of: OpenAI's own models (openai/…, not gpt-oss), or add your organisation's own OpenRouter key in Settings → AI key."
    );
    expect(await refuseModel(db, "openai/gpt-oss-120b")).toMatch(/is not available on Board Planner's AI key/);
    expect(await refuseModel(db, "openai/gpt-4o:online")).toMatch(/is not available on Board Planner's AI key/);
  });

  it("is accepted there when it is an allowed provider's, a bare OpenAI name included", async () => {
    expect(await refuseModel(db, "openai/gpt-6-luna")).toBeNull();
    expect(await refuseModel(db, " gpt-4o-mini ")).toBeNull();
  });

  it("is accepted on the organisation's own key whatever the provider, when OpenRouter lists it", async () => {
    modelsRestricted.mockResolvedValue(false);

    expect(await refuseModel(db, "anthropic/claude-haiku-5.5")).toBeNull();
    expect(await refuseModel(db, "openai/gpt-oss-120b")).toBeNull();
  });

  it("is refused when OpenRouter lists no such model, on either key, with a variant suffix not part of the name", async () => {
    expect(await refuseModel(db, "openai/gpt-9-typo")).toBe("OpenRouter has no model openai/gpt-9-typo. Check the name against openrouter.ai/models.");
    modelsRestricted.mockResolvedValue(false);
    expect(await refuseModel(db, "anthropic/claude-haiku-5")).toMatch(/OpenRouter has no model anthropic\/claude-haiku-5\./);
    expect(await refuseModel(db, "anthropic/claude-haiku-5.5:online")).toBeNull();
  });

  it("is judged by the allowed providers alone when OpenRouter's list cannot be read: unknown is not absent", async () => {
    listCatalogue.mockResolvedValue(null);

    expect(await refuseModel(db, "openai/gpt-9-typo")).toBeNull();
    expect(await refuseModel(db, "anthropic/claude-haiku-5.5")).toMatch(/is not available on Board Planner's AI key/);
  });

  it("is no choice at all when empty: a project that names none follows the default, and nothing is asked", async () => {
    expect(await refuseModel(db, "  ")).toBeNull();
    expect(modelsRestricted).not.toHaveBeenCalled();
    expect(listCatalogue).not.toHaveBeenCalled();
  });
});

describe("the models only the organisation's own key runs", () => {
  beforeEach(() => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
    process.env.OPENROUTER_API_KEY = "sk-operators";
  });

  it("are the default's and every project's that the platform's key would refuse, once each, when removing the key hands the calls to ours", async () => {
    saved = { aiModel: "anthropic/claude-haiku-5.5" };
    projects = [{ pm: { model: "anthropic/claude-haiku-5.5" } }, { pm: { model: "openai/gpt-6-luna" } }, { pm: { model: "moonshotai/kimi-k2.6" } }, { pm: {} }];

    expect(await modelsLostWithOwnKey(db)).toEqual(["anthropic/claude-haiku-5.5", "moonshotai/kimi-k2.6"]);
  });

  it("are none where ours would not run the calls anyway: a plan without managed AI, no operator key, or a self-hosted instance", async () => {
    saved = { aiModel: "anthropic/claude-haiku-5.5" };

    can.mockReturnValue(false);
    expect(await modelsLostWithOwnKey(db)).toEqual([]);

    can.mockReturnValue(true);
    delete process.env.OPENROUTER_API_KEY;
    expect(await modelsLostWithOwnKey(db)).toEqual([]);

    process.env.OPENROUTER_API_KEY = "sk-instance";
    delete process.env.ORGANISATION_DOMAIN;
    expect(await modelsLostWithOwnKey(db)).toEqual([]);
  });

  it("are none when every model in use is one ours runs", async () => {
    projects = [{ pm: { model: "openai/gpt-4o-mini" } }];

    expect(await modelsLostWithOwnKey(db)).toEqual([]);
  });
});

describe("the model saved for the organisation", () => {
  it("is the stored one, and the default where nothing is stored yet", async () => {
    const { savedAiModel } = await import("./model-check");
    saved = { aiModel: "anthropic/claude-haiku-5.5" };
    expect(await savedAiModel(db)).toBe("anthropic/claude-haiku-5.5");

    saved = null;
    expect(await savedAiModel(db)).toBe("openai/gpt-6-luna");
  });
});
