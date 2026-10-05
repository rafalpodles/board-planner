import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const find = vi.fn();
const openDownloadStream = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { loadAttachmentDataUri, buildUserContent, anyAttachmentReadable } = await import("./attachments");
const { scoped } = await import("@/lib/db-scope");

const ORGANISATION = new mongoose.Types.ObjectId("0000000000000000000000a1");
const OTHER_ORGANISATION = new mongoose.Types.ObjectId("0000000000000000000000b2");
const DB = scoped(ORGANISATION);

const FILE_ID = "507f1f77bcf86cd799439011";
const PROJECT = "69a52e3b399b27d3cbb2c5a5";
const OTHER_PROJECT = "69a52e3b399b27d3cbb2c5b7";
const PIXEL = Buffer.from("png-bytes");

function attachment(overrides: Record<string, unknown> = {}) {
  return { fileId: FILE_ID, mimeType: "image/png", ...overrides } as never;
}

// Honours the filter the way GridFS would, so a file of another organisation is not found
function bucketHas(metadata: Record<string, unknown> | null) {
  const rows = metadata === null ? [] : [{ _id: new mongoose.Types.ObjectId(FILE_ID), metadata: { organisation: ORGANISATION, ...metadata } }];
  find.mockImplementation((filter: Record<string, unknown>) => ({
    toArray: () =>
      Promise.resolve(rows.filter((row) => String(row.metadata.organisation) === String(filter["metadata.organisation"]))),
  }));
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
    const uri = await loadAttachmentDataUri(DB, attachment(), PROJECT);

    expect(uri).toBe(`data:image/png;base64,${PIXEL.toString("base64")}`);
  });

  it("returns nothing for a file belonging to another project", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    expect(await loadAttachmentDataUri(DB, attachment(), PROJECT)).toBeNull();
  });

  // Files stored before the owner was recorded: unreadable rather than readable by everyone
  it.each([
    ["no metadata", null as unknown as Record<string, unknown>],
    ["metadata without a project", {}],
    ["an empty project", { project: "" }],
  ])("returns nothing for a file with %s", async (_case, metadata) => {
    bucketHas(metadata ?? {});

    expect(await loadAttachmentDataUri(DB, attachment(), PROJECT)).toBeNull();
  });

  // The route refuses first and streams second; this used to drain the whole file and compare
  // afterwards, so another board's member could spend the server's memory on files they could
  // never see — and any log line added between the two would have leaked them
  it("does not read the bytes of a file it is going to refuse", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    await loadAttachmentDataUri(DB, attachment(), PROJECT);

    expect(openDownloadStream).not.toHaveBeenCalled();
  });

  it("returns nothing when there is no such file", async () => {
    bucketHas(null);

    expect(await loadAttachmentDataUri(DB, attachment(), PROJECT)).toBeNull();
    expect(openDownloadStream).not.toHaveBeenCalled();
  });

  it("returns nothing for a file id that is not an ObjectId", async () => {
    expect(await loadAttachmentDataUri(DB, attachment({ fileId: "nope" }), PROJECT)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  // The stored type decides, not the one the caller put in the attachment record — otherwise a
  // caller names image/png over a PDF and the model is handed something else entirely
  it("takes the content type from the file, not from the caller", async () => {
    bucketHas({ project: PROJECT, contentType: "application/pdf" });

    expect(await loadAttachmentDataUri(DB, attachment({ mimeType: "image/png" }), PROJECT)).toBeNull();
  });

  it("refuses a non-image even when it belongs to the project", async () => {
    bucketHas({ project: PROJECT, contentType: "text/csv" });

    expect(await loadAttachmentDataUri(DB, attachment({ mimeType: "text/csv" }), PROJECT)).toBeNull();
  });
});

describe("buildUserContent", () => {
  it("leaves a text-only turn exactly as it was", async () => {
    expect(await buildUserContent(DB, "hello", undefined, PROJECT)).toBe("hello");
    expect(await buildUserContent(DB, "hello", [], PROJECT)).toBe("hello");
  });

  it("drops an attachment the project may not read rather than failing the turn", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    const content = await buildUserContent(DB, "look", [attachment()], PROJECT);

    expect(JSON.stringify(content)).not.toContain("base64");
  });

  // An image on its own carries no words, and an empty text block is a shape providers reject
  it("sends the picture with no text block when nothing was typed", async () => {
    bucketHas({ project: PROJECT, contentType: "image/png" });

    const content = (await buildUserContent(DB, "", [attachment()], PROJECT)) as Record<
      string,
      unknown
    >[];

    expect(Array.isArray(content)).toBe(true);
    expect(content.map((b) => b.type)).toEqual(["image_url"]);
  });

  it("keeps the text block when there is text", async () => {
    bucketHas({ project: PROJECT, contentType: "image/png" });

    const content = (await buildUserContent(DB, "look", [attachment()], PROJECT)) as Record<
      string,
      unknown
    >[];

    expect(content.map((b) => b.type)).toEqual(["text", "image_url"]);
  });

  // The empty-string fallback is what reaches the provider when no image survives, and for an
  // image-only turn that is a turn carrying nothing at all
  it("falls back to the text, which for an image-only turn is empty", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    expect(await buildUserContent(DB, "", [attachment()], PROJECT)).toBe("");
  });
});

describe("anyAttachmentReadable", () => {
  it("accepts an image this project owns", async () => {
    bucketHas({ project: PROJECT, contentType: "image/png" });

    expect(await anyAttachmentReadable(DB, [attachment()], PROJECT)).toBe(true);
  });

  // The arm the e2e cannot reach, and the one whose absence is a cross-board read
  it("refuses one that belongs to another board", async () => {
    bucketHas({ project: OTHER_PROJECT, contentType: "image/png" });

    expect(await anyAttachmentReadable(DB, [attachment()], PROJECT)).toBe(false);
  });

  it("refuses a file that is not an image", async () => {
    bucketHas({ project: PROJECT, contentType: "text/csv" });

    expect(await anyAttachmentReadable(DB, [attachment({ mimeType: "text/csv" })], PROJECT)).toBe(false);
  });

  it("refuses a fileId that names no file, and one that is not an id at all", async () => {
    bucketHas(null);
    expect(await anyAttachmentReadable(DB, [attachment()], PROJECT)).toBe(false);
    expect(await anyAttachmentReadable(DB, [attachment({ fileId: "not-an-id" })], PROJECT)).toBe(false);
  });

  // ObjectId takes hex in any case and stringifies it lowercase, so a map keyed on what the client
  // typed misses every non-canonical spelling — and the file falls back to no mime at all
  it("takes the claimed mime for a legacy file however the id was spelled", async () => {
    bucketHas({ project: PROJECT });

    expect(await anyAttachmentReadable(DB, [attachment({ fileId: FILE_ID.toUpperCase() })], PROJECT)).toBe(
      true
    );
  });
});
