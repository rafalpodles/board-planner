import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const getAuthUser = vi.fn();
const check = vi.fn();
const find = vi.fn();
const openDownloadStream = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check }));
vi.mock("@/lib/upload-ownership", async (importOriginal) => ({
  // projectForUpload stays real: it is half of the rule under test, and a mock of it would
  // assert my own arrangement rather than the code's
  ...(await importOriginal<typeof import("@/lib/upload-ownership")>()),
  uploadsBucket: () => ({ find, openDownloadStream }),
}));

const { GET } = await import("./route");

const OWNER = { _id: "u1", role: "member" };
const FILE_ID = "507f1f77bcf86cd799439011";
const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const OTHER_PROJECT = "69a52e3b399b27d3cbb2c5b7";

function storedFile(metadata: Record<string, unknown> | null = { project: PROJECT }) {
  return { _id: new mongoose.Types.ObjectId(FILE_ID), metadata };
}

function request() {
  return new Request(`https://app.example.com/api/uploads/${FILE_ID}`);
}

const ctx = (fileId = FILE_ID) => ({ params: Promise.resolve({ fileId }) });

function bucketHas(...files: unknown[]) {
  find.mockReturnValue({ toArray: () => Promise.resolve(files) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  check.mockResolvedValue(true);
  bucketHas(storedFile());
  openDownloadStream.mockReturnValue(
    new (require("stream").Readable)({
      read() {
        this.push(Buffer.from("file-bytes"));
        this.push(null);
      },
    })
  );
});

/**
 * BP-290 reported uploads as reachable without a per-project check. That was true when it was
 * filed and was closed by #119 — but the rule lived only in the route, and the only test was on
 * the `projectForUpload` helper. So deleting the `check(...)` call left the suite green, which is
 * the same shape of gap as the finding itself.
 *
 * These drive the route.
 */
describe("GET /api/uploads/[fileId]", () => {
  it("serves a file to somebody with access to its project", async () => {
    const response = await GET(request(), ctx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file-bytes");
    expect(check).toHaveBeenCalledWith(OWNER, PROJECT, "access");
  });

  it("refuses somebody whose grants do not cover that project", async () => {
    check.mockResolvedValue(false);

    const response = await GET(request(), ctx());

    expect(response.status).toBe(404);
    expect(openDownloadStream).not.toHaveBeenCalled();
  });

  // 404 rather than 403 on purpose: a file id is a bare ObjectId, so telling the two apart would
  // confirm the existence of other boards' attachments to anyone enumerating ids
  it("says not-found rather than forbidden, so the id cannot be probed", async () => {
    check.mockResolvedValue(false);
    const refused = await GET(request(), ctx());

    bucketHas();
    const missing = await GET(request(), ctx());

    expect(refused.status).toBe(missing.status);
    expect(await refused.text()).toBe(await missing.text());
  });

  it("refuses an unauthenticated caller before looking at the bucket", async () => {
    getAuthUser.mockResolvedValue(null);

    const response = await GET(request(), ctx());

    expect(response.status).toBe(401);
    expect(find).not.toHaveBeenCalled();
  });

  // Files stored before #119 carry no owner. They are unreadable until the migration stamps them,
  // which is the safe direction: the alternative was resolving an owner per request, and that
  // search was attacker-controlled.
  it.each([
    ["no metadata at all", null],
    ["metadata without a project", {}],
    ["an empty project", { project: "" }],
  ])("refuses a file with %s rather than guessing an owner", async (_case, metadata) => {
    bucketHas(storedFile(metadata));

    const response = await GET(request(), ctx());

    expect(response.status).toBe(404);
    expect(check).not.toHaveBeenCalled();
    expect(openDownloadStream).not.toHaveBeenCalled();
  });

  it("checks the project the file records, not one the caller can name", async () => {
    bucketHas(storedFile({ project: OTHER_PROJECT }));

    await GET(request(), ctx());

    expect(check).toHaveBeenCalledWith(OWNER, OTHER_PROJECT, "access");
  });

  it("refuses a file id that is not an ObjectId", async () => {
    const response = await GET(request(), ctx("not-an-id"));

    expect(response.status).toBe(400);
    expect(find).not.toHaveBeenCalled();
  });

  // SVG can carry script, so it is served as a download rather than rendered in the app's origin
  it.each([
    ["image/png", "inline"],
    ["image/jpeg", "inline"],
    ["image/svg+xml", "attachment"],
    ["application/pdf", "attachment"],
    ["text/html", "attachment"],
  ])("serves %s as %s", async (contentType, disposition) => {
    bucketHas(storedFile({ project: PROJECT, contentType }));

    const response = await GET(request(), ctx());

    expect(response.headers.get("content-disposition")).toBe(disposition);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not let a cache hold somebody else's attachment", async () => {
    const response = await GET(request(), ctx());

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
