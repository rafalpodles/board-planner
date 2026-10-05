import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const { findOne, organisationOrigin } = vi.hoisted(() => ({ findOne: vi.fn(), organisationOrigin: vi.fn() }));

vi.mock("@/models/oidcFlow", () => ({ OidcFlow: { findOne } }));
vi.mock("../organisation-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../organisation-host")>()),
  organisationOrigin,
}));

const { relayedHome } = await import("./relay");

const GLOBEX = new Types.ObjectId("0000000000000000000000b2");

function flowIs(row: unknown) {
  findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(row) }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ORGANISATION_DOMAIN = "board-planner.test";
});

afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
});

describe("relayedHome with organisations on subdomains (BP-895)", () => {
  it("finds a live sign-in by its state in whichever organisation began it, and sends it home there", async () => {
    flowIs({ organisation: GLOBEX });
    organisationOrigin.mockResolvedValue("https://globex.board-planner.test");

    expect(await relayedHome("oidc", "st-1")).toBe("https://globex.board-planner.test");
    const [filter] = findOne.mock.calls[0];
    expect(filter).toMatchObject({ state: "st-1", provider: "oidc", claims: null });
    expect(filter).not.toHaveProperty("organisation");
    expect(organisationOrigin).toHaveBeenCalledWith(GLOBEX);
  });

  it("calls an unknown, spent or other-provider state expired, and looks up no address for it", async () => {
    flowIs(null);

    expect(await relayedHome("oidc", "st-unknown")).toBe("expired");
    expect(organisationOrigin).not.toHaveBeenCalled();
  });

  it("answers no address for an organisation that has none, rather than guessing one", async () => {
    flowIs({ organisation: GLOBEX });
    organisationOrigin.mockResolvedValue(null);

    expect(await relayedHome("oidc", "st-1")).toBeNull();
  });
});
