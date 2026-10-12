import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";
import { gunzipSync } from "node:zlib";

const { identity, findById, createAudit, projectExport } = vi.hoisted(() => ({
  identity: { viaMachineCredential: false },
  findById: vi.fn(),
  createAudit: vi.fn(),
  projectExport: vi.fn(),
}));

const BOARD = new Types.ObjectId("0000000000000000000000c3");
const ORGANISATION = new Types.ObjectId("0000000000000000000000a1");

vi.mock("@/lib/project-export", () => ({ projectExport }));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (request: Request, context: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        user: { _id: "u1", ...identity },
        db: { organisation: ORGANISATION, Project: { findById }, ProjectAuditLog: { create: createAudit } },
        params: Promise.resolve({ projectId: String(BOARD) }),
      }),
}));

const { GET } = await import("./route");
const call = (query = "") => (GET as unknown as (request: Request) => Promise<Response>)(new Request(`https://x/api/projects/MINE/export${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  identity.viaMachineCredential = false;
  findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: BOARD, key: "MINE" }) }) });
  createAudit.mockResolvedValue({});
  projectExport.mockImplementation(async function* () {
    yield '{"format":"board-planner-project-export"}\n';
    yield '{"collection":"Task"}\n';
  });
});

describe("GET /api/projects/[projectId]/export (BP-1011)", () => {
  it("streams the project's lines as a gzip download named for its key, and records it first", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="mine-export-\d{4}-\d{2}-\d{2}\.ndjson\.gz"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createAudit).toHaveBeenCalledWith({ project: BOARD, user: "u1", action: "project_exported", detail: "" });
    expect(createAudit.mock.invocationCallOrder[0]).toBeLessThan(projectExport.mock.invocationCallOrder[0]);
    expect(projectExport).toHaveBeenCalledWith(expect.objectContaining({ organisation: ORGANISATION }), BOARD);
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(
      '{"format":"board-planner-project-export"}\n{"collection":"Task"}\n'
    );
  });

  it("answers the page's check with 204 and neither records nor reads anything", async () => {
    const response = await call("?check=1");

    expect(response.status).toBe(204);
    expect(createAudit).not.toHaveBeenCalled();
    expect(projectExport).not.toHaveBeenCalled();
  });

  it("refuses an API token or a connected app, and records nothing", async () => {
    identity.viaMachineCredential = true;

    const response = await call();

    expect(response.status).toBe(403);
    expect(findById).not.toHaveBeenCalled();
    expect(createAudit).not.toHaveBeenCalled();
  });

  it("answers 404 for a project that is gone", async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    expect((await call()).status).toBe(404);
    expect(createAudit).not.toHaveBeenCalled();
  });

  it("sends no byte of a download it could not record", async () => {
    createAudit.mockRejectedValue(new Error("db down"));

    await expect(call()).rejects.toThrow("db down");
    expect(projectExport).not.toHaveBeenCalled();
  });
});
