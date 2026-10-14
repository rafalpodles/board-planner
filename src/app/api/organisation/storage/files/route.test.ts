import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const largest = vi.fn();
const count = vi.fn();
const projectFind = vi.fn();
const userFind = vi.fn();

const session = { viaMachineCredential: false };
vi.mock("@/lib/middleware", () => ({
  withAdmin: (handler: (request: Request, context: unknown) => unknown) => (request: Request) =>
    handler(request, { params: Promise.resolve({}), user: session, db: { Project: { find: projectFind }, User: { find: userFind } } }),
}));
vi.mock("@/lib/upload-ownership", () => ({ organisationUploads: () => ({ largest, count }) }));

const { GET } = await import("./route");

const BOARD = new mongoose.Types.ObjectId();
const PERSON = new mongoose.Types.ObjectId();
const lean = (rows: unknown[]) => ({ lean: async () => rows });

beforeEach(() => {
  vi.clearAllMocks();
  session.viaMachineCredential = false;
  count.mockResolvedValue(40);
  projectFind.mockReturnValue(lean([{ _id: BOARD, key: "TP", name: "Test Project" }]));
  userFind.mockReturnValue(lean([{ _id: PERSON, username: "ola" }]));
});

describe("GET /api/organisation/storage/files (BP-1025)", () => {
  it("names each file's board and uploader, and says how many files there are in all", async () => {
    largest.mockResolvedValue([
      {
        _id: new mongoose.Types.ObjectId("6a9d0f0b5d781bded2cb9901"),
        filename: "plan.pdf",
        length: 5_000_000,
        uploadDate: new Date("2026-10-01T10:00:00Z"),
        metadata: { contentType: "application/pdf", project: BOARD, uploadedBy: String(PERSON) },
      },
    ]);

    const body = await (await GET(new Request("https://x/api/organisation/storage/files"), { params: Promise.resolve({}) })).json();

    expect(largest).toHaveBeenCalledWith(25);
    expect(body.total).toBe(40);
    expect(body.files).toEqual([
      {
        id: "6a9d0f0b5d781bded2cb9901",
        name: "plan.pdf",
        size: 5_000_000,
        contentType: "application/pdf",
        uploadedAt: "2026-10-01T10:00:00.000Z",
        project: { key: "TP", name: "Test Project" },
        uploadedBy: "ola",
      },
    ]);
  });

  it("still lists a file whose board or uploader is gone, with nobody named", async () => {
    largest.mockResolvedValue([
      {
        _id: new mongoose.Types.ObjectId(),
        filename: "old.png",
        length: 10,
        uploadDate: new Date(),
        metadata: { project: new mongoose.Types.ObjectId(), uploadedBy: "not-an-id" },
      },
    ]);

    const [file] = (await (await GET(new Request("https://x/api/organisation/storage/files"), { params: Promise.resolve({}) })).json()).files;

    expect(file).toMatchObject({ name: "old.png", project: null, uploadedBy: null, contentType: null });
  });

  it("is not for a machine credential: an admin token on a worker's disk does not read the file names", async () => {
    session.viaMachineCredential = true;

    const response = await GET(new Request("https://x/api/organisation/storage/files"), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(largest).not.toHaveBeenCalled();
  });
});
