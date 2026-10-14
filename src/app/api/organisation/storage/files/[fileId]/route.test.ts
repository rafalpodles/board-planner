import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const discard = vi.fn();
const logInstanceAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/middleware", () => ({
  withAdmin: (handler: (request: Request, context: unknown) => unknown) => (request: Request, context: { params: Promise<unknown> }) =>
    handler(request, { params: context.params, user: { _id: "admin-1", username: "root" }, db: {} }),
}));
vi.mock("@/lib/upload-ownership", () => ({ organisationUploads: () => ({ discard }) }));

const { DELETE } = await import("./route");

const FILE = "6a9d0f0b5d781bded2cb9901";
const remove = (fileId: string) =>
  DELETE(new Request(`https://x/api/organisation/storage/files/${fileId}`, { method: "DELETE" }), { params: Promise.resolve({ fileId }) });

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/organisation/storage/files/:fileId (BP-1025)", () => {
  it("deletes the file, says how much it freed and leaves a row in the audit log naming the file and who did it", async () => {
    discard.mockResolvedValue({ _id: new mongoose.Types.ObjectId(FILE), filename: "plan.pdf", length: 5 * 1024 * 1024 });

    const response = await remove(FILE);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ freedBytes: 5 * 1024 * 1024 });
    expect(String(discard.mock.calls[0][0])).toBe(FILE);
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "upload_deleted", actorUsername: "root", target: "plan.pdf", detail: "5 MB" })
    );
  });

  it("answers 404 for a file this organisation does not have, and writes no audit row", async () => {
    discard.mockResolvedValue(null);

    expect((await remove(FILE)).status).toBe(404);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("answers 400 for something that is not a file id, before touching anything", async () => {
    expect((await remove("not-an-id")).status).toBe(400);
    expect(discard).not.toHaveBeenCalled();
  });
});
