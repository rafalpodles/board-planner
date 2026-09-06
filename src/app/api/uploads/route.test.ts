import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const getAuthUser = vi.fn();
const check = vi.fn();
const resolveProjectId = vi.fn();
const openUploadStream = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/middleware")>()),
  resolveProjectId,
}));

const { POST } = await import("./route");

const USER = { _id: "u1", role: "member" };
const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const FILE_ID = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");

function form(fields: Record<string, string | File>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

function png(name = "shot.png", bytes = 10) {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function request(body: FormData) {
  return new Request("https://app.example.com/api/uploads", { method: "POST", body });
}

const ctx = () => ({ params: Promise.resolve({}) });

function uploadedMetadata() {
  return openUploadStream.mock.calls[0][1].metadata as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(USER);
  check.mockResolvedValue(true);
  resolveProjectId.mockResolvedValue(PROJECT);

  const { Writable } = require("stream");
  openUploadStream.mockImplementation(() => {
    const stream = new Writable({ write: (_c: unknown, _e: unknown, cb: () => void) => cb() });
    Object.assign(stream, { id: FILE_ID });
    return stream;
  });
  vi.spyOn(mongoose.mongo, "GridFSBucket").mockImplementation(
    () => ({ openUploadStream }) as unknown as mongoose.mongo.GridFSBucket
  );
  vi.spyOn(mongoose, "connection", "get").mockReturnValue({
    db: {},
  } as unknown as mongoose.Connection);
});

describe("POST /api/uploads", () => {
  it("stores the project on the file, which is what the read side checks", async () => {
    const response = await POST(request(form({ file: png(), projectId: "BP" })), ctx());

    expect(response.status).toBe(200);
    expect(check).toHaveBeenCalledWith(USER, PROJECT, "access");
    expect(uploadedMetadata().project).toBe(PROJECT);
    expect(uploadedMetadata().uploadedBy).toBe("u1");
  });

  it("refuses an upload that names no project", async () => {
    const response = await POST(request(form({ file: png() })), ctx());

    expect(response.status).toBe(400);
    expect(openUploadStream).not.toHaveBeenCalled();
  });

  it("refuses an upload to a project the caller cannot reach", async () => {
    check.mockResolvedValue(false);

    const response = await POST(request(form({ file: png(), projectId: "BP" })), ctx());

    expect(response.status).toBe(403);
    expect(openUploadStream).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    getAuthUser.mockResolvedValue(null);

    const response = await POST(request(form({ file: png(), projectId: "BP" })), ctx());

    expect(response.status).toBe(401);
    expect(openUploadStream).not.toHaveBeenCalled();
  });

  it("refuses a project that does not exist rather than storing an unresolvable owner", async () => {
    resolveProjectId.mockResolvedValue(null);

    const response = await POST(request(form({ file: png(), projectId: "NOPE" })), ctx());

    expect(response.status).toBe(404);
    expect(openUploadStream).not.toHaveBeenCalled();
  });

  it("records the resolved id, not the key the caller typed", async () => {
    await POST(request(form({ file: png(), projectId: "BP" })), ctx());

    expect(resolveProjectId).toHaveBeenCalledWith("BP");
    expect(uploadedMetadata().project).toBe(PROJECT);
  });

  it("refuses a type that is not on the allowlist", async () => {
    const script = new File(["alert(1)"], "x.js", { type: "text/javascript" });

    const response = await POST(request(form({ file: script, projectId: "BP" })), ctx());

    expect(response.status).toBe(400);
    expect(openUploadStream).not.toHaveBeenCalled();
  });

  it("refuses a file over the size limit", async () => {
    const big = png("big.png", 5 * 1024 * 1024 + 1);

    const response = await POST(request(form({ file: big, projectId: "BP" })), ctx());

    expect(response.status).toBe(413);
    expect(openUploadStream).not.toHaveBeenCalled();
  });

  it("refuses a request with no file", async () => {
    const response = await POST(request(form({ projectId: "BP" })), ctx());

    expect(response.status).toBe(400);
  });
});
