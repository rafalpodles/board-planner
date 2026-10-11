import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, modelsRestricted, listCatalogue, savedAiModel } = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  modelsRestricted: vi.fn(),
  listCatalogue: vi.fn(),
  savedAiModel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/model-keys", () => ({ modelsRestricted }));
vi.mock("@/lib/openrouter-catalogue", () => ({ listCatalogue }));
vi.mock("@/lib/model-check", () => ({ savedAiModel }));
// The host check reads the database in the cloud; the request here always comes from the organisation's own host
vi.mock("@/lib/organisation-host", async (importOriginal) => {
  const { scopedToDefaultOrganisation } = await vi.importActual<typeof import("@/lib/db-scope")>("@/lib/db-scope");
  return {
    ...(await importOriginal<typeof import("@/lib/organisation-host")>()),
    organisationOfRequest: async () => ({ kind: "organisation", organisation: scopedToDefaultOrganisation().organisation }),
  };
});

const { GET } = await import("./route");

const ADMIN = { _id: "a1", username: "root", role: "admin", viaMachineCredential: false };
const get = () => GET(new Request("http://x/api/settings/ai-models"), { params: Promise.resolve({}) });

const CATALOGUE = [
  { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" },
  { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
  { id: "openai/gpt-oss-120b", name: "OpenAI: gpt-oss-120b" },
  { id: "openai/gpt-4o:online", name: "OpenAI: GPT-4o (online)" },
];

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  modelsRestricted.mockResolvedValue(true);
  listCatalogue.mockResolvedValue(CATALOGUE);
  savedAiModel.mockResolvedValue("openai/gpt-4o");
});

// BP-1024
describe("GET /api/settings/ai-models", () => {
  it("offers on the platform's key only the models it runs, and names the providers", async () => {
    const body = await (await get()).json();

    expect(body).toEqual({
      restricted: true,
      model: "openai/gpt-4o",
      models: [
        { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" },
        { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
      ],
      providers: [
        { id: "openai", label: "OpenAI" },
        { id: "anthropic", label: "Anthropic" },
        { id: "google", label: "Google" },
        { id: "mistralai", label: "Mistral" },
      ],
    });
  });

  it("offers on the organisation's own key every model OpenRouter lists, and no provider to name", async () => {
    modelsRestricted.mockResolvedValue(false);

    const body = await (await get()).json();

    expect(body.restricted).toBe(false);
    expect(body.models).toHaveLength(CATALOGUE.length);
    expect(body.providers).toBeNull();
  });

  it("says the list is unknown when OpenRouter cannot be read, rather than that no model runs", async () => {
    listCatalogue.mockResolvedValue(null);

    expect((await (await get()).json()).models).toBeNull();
  });

  it("answers no member", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, role: "member" });

    expect((await get()).status).toBe(403);
  });
});
