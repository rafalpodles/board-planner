import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const find = vi.fn();
const openDownloadStream = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { loadAttachmentDataUri, buildUserContent } = await import("./attachments");

const FILE_ID = "507f1f77bcf86cd799439011";
const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const OTHER_PROJECT = "69a52e3b399b27d3cbb2c5b7";
const PIXEL = Buffer.from("png-bytes");

function attachment(overrides: Record<string, unknown> = {}) {
  return { fileId: FILE_ID, mimeType: "image/png", ...overrides } as never;
}

function bucketHas(metadata: Record<string, unknown> | null) {
  find.mockReturnValue({
    toArray: () =>
      Promise.resolve(
        metadata === null ? [] : [{ _id: new mongoose.Types.ObjectId(FILE_ID), metadata }]
      ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bucketHas({ project: PROJECT, contentType: "image/png" });
  openDownloadStream.mockImplementation(async function* () {
    yield PIXEL;
  });
  vi.spyOn(mongoose.mongo, "GridFSBucket").mockImplementation(
    () => ({ find, openDownloadStream }) as unknown as mongoose.mongo.GridFSBucket
  );
  vi.spyOn(mongoose, "connection", "get").mockReturnValue({
    db: {},
  } as unknown as mongoose.Connection);
});

/**
 * The second way to read a file out of GridFS, and the one with no test.
 *
 * Its own comment says leaving it ungated "made the ownership check on GET /api/uploads/[fileId]
 * bypassable outright" — and the BP-290 review proved the point by deleting that comparison and
 * running the whole suite green. The route-level gate this branch pinned is untouched by any of
 * it: the PM agent reaches the bytes without going through the route.
 */
describe("loadAttachmentDataUri", () => {
  it("returns the image when the file belongs to the project asking for it", async () => {
    const uri = await loadAttachmentDataUri(attachment(), PROJECT);

    expect(uri).toBe(`data:image/png;base64,${PIXEL.toString("base64")}`);
  });

  it("returns nothing for a file belonging to another project", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    expect(await loadAttachmentDataUri(attachment(), PROJECT)).toBeNull();
  });

  // Files stored before the owner was recorded: unreadable rather than readable by everyone
  it.each([
    ["no metadata", null as unknown as Record<string, unknown>],
    ["metadata without a project", {}],
    ["an empty project", { project: "" }],
  ])("returns nothing for a file with %s", async (_case, metadata) => {
    bucketHas(metadata ?? {});

    expect(await loadAttachmentDataUri(attachment(), PROJECT)).toBeNull();
  });

  // The route refuses first and streams second; this used to drain the whole file and compare
  // afterwards, so another board's member could spend the server's memory on files they could
  // never see — and any log line added between the two would have leaked them
  it("does not read the bytes of a file it is going to refuse", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    await loadAttachmentDataUri(attachment(), PROJECT);

    expect(openDownloadStream).not.toHaveBeenCalled();
  });

  it("returns nothing when there is no such file", async () => {
    bucketHas(null);

    expect(await loadAttachmentDataUri(attachment(), PROJECT)).toBeNull();
    expect(openDownloadStream).not.toHaveBeenCalled();
  });

  it("returns nothing for a file id that is not an ObjectId", async () => {
    expect(await loadAttachmentDataUri(attachment({ fileId: "nope" }), PROJECT)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  // The stored type decides, not the one the caller put in the attachment record — otherwise a
  // caller names image/png over a PDF and the model is handed something else entirely
  it("takes the content type from the file, not from the caller", async () => {
    bucketHas({ project: PROJECT, contentType: "application/pdf" });

    expect(await loadAttachmentDataUri(attachment({ mimeType: "image/png" }), PROJECT)).toBeNull();
  });

  it("refuses a non-image even when it belongs to the project", async () => {
    bucketHas({ project: PROJECT, contentType: "text/csv" });

    expect(await loadAttachmentDataUri(attachment({ mimeType: "text/csv" }), PROJECT)).toBeNull();
  });
});

describe("buildUserContent", () => {
  it("leaves a text-only turn exactly as it was", async () => {
    expect(await buildUserContent("hello", undefined, PROJECT)).toBe("hello");
    expect(await buildUserContent("hello", [], PROJECT)).toBe("hello");
  });

  it("drops an attachment the project may not read rather than failing the turn", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    const content = await buildUserContent("look", [attachment()], PROJECT);

    expect(JSON.stringify(content)).not.toContain("base64");
  });
});
