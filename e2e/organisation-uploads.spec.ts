import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { Readable } from "node:stream";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, seed } from "./seed";
import { backfillOrganisations } from "../src/lib/organisation-migration";
import { DEFAULT_ORGANISATION_ID } from "../src/lib/organisation-field";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const ELSEWHERE = new mongoose.Types.ObjectId("0000000000000000000000b2");

async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

// Written straight to GridFS, the way a release before BP-668 did, or with another organisation
function storeByHand(metadata: Record<string, unknown>): Promise<string> {
  return withDb(async (db) => {
    const stream = new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" }).openUploadStream("old.png", {
      metadata: { contentType: "image/png", project: PROJECT_ID, ...metadata },
    });
    await new Promise<void>((resolve, reject) => Readable.from(TINY_PNG).pipe(stream).on("finish", resolve).on("error", reject));
    return String(stream.id);
  });
}

const read = (request: APIRequestContext, id: string) => request.get(`/api/uploads/${id}`, { headers: ADMIN_AUTH });

test.beforeEach(async () => {
  await seed();
});

test.describe("BP-668: every uploaded file belongs to an organisation", () => {
  test("an upload is stored with the organisation it was made in, and reads back", async ({ request }) => {
    const response = await request.post("/api/uploads", {
      headers: ADMIN_AUTH,
      multipart: { file: { name: "plan.png", mimeType: "image/png", buffer: TINY_PNG }, projectId: String(PROJECT_ID) },
    });
    expect(response.status(), await response.text()).toBe(200);
    const id = new URL((await response.json()).url, "http://x").pathname.split("/").pop()!;

    const stored = await withDb((db) => db.collection("uploads.files").findOne({ _id: new mongoose.Types.ObjectId(id) }));
    expect(String(stored!.metadata.organisation)).toBe(String(DEFAULT_ORGANISATION_ID));
    expect((await read(request, id)).status()).toBe(200);
  });

  test("a file stamped with another organisation is not served, though it names a board the reader can see", async ({ request }) => {
    const id = await storeByHand({ organisation: ELSEWHERE });

    expect((await read(request, id)).status()).toBe(404);
  });

  test("a file from before organisations is not served until the backfill gives it one, then it is", async ({ request }) => {
    const id = await storeByHand({});
    expect((await read(request, id)).status()).toBe(404);

    const { byCollection } = await withDb(() => backfillOrganisations(mongoose.connection, { apply: true }));
    expect(byCollection["uploads.files"]).toBe(1);

    const response = await read(request, id);
    expect(response.status()).toBe(200);
    expect(Buffer.from(await response.body()).equals(TINY_PNG)).toBe(true);
  });
});
