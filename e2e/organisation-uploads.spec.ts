import { test, expect, type APIRequestContext } from "@playwright/test";
import mongoose from "mongoose";
import { Readable } from "node:stream";
import { ADMIN_AUTH, MEMBER_AUTH, SAME_ORIGIN } from "./api";
import { signIn } from "./session";
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

// BP-1025: nothing removed an uploaded file, so a Free organisation that was full could only buy Pro
test.describe("BP-1025: an administrator deletes a file to make room", () => {
  async function upload(request: APIRequestContext, name: string): Promise<string> {
    const response = await request.post("/api/uploads", {
      headers: ADMIN_AUTH,
      multipart: { file: { name, mimeType: "image/png", buffer: TINY_PNG }, projectId: String(PROJECT_ID) },
    });
    expect(response.status(), await response.text()).toBe(200);
    return new URL((await response.json()).url, "http://x").pathname.split("/").pop()!;
  }

  test("lists the files, deletes one after asking, and the space, the file and the audit log all follow", async ({ page, request }) => {
    const id = await upload(request, "floor-plan.png");
    await signIn(page);
    await page.goto("/settings/organisation");
    await expect(page.getByTestId("organisation-storage-used")).toHaveText("1 MB");

    await page.getByTestId("storage-files-toggle").click();
    const row = page.getByTestId("storage-file").filter({ hasText: "floor-plan.png" });
    await expect(row).toBeVisible();
    const board = await withDb((db) => db.collection("projects").findOne({ _id: PROJECT_ID }));
    await expect(row).toContainText(String(board!.name));

    await row.getByRole("button", { name: "Delete floor-plan.png" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete floor-plan.png?" });
    await expect(dialog).toContainText("cannot be undone");
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByTestId("storage-files-empty")).toBeVisible();
    await expect(page.getByTestId("organisation-storage-used")).toHaveText("0 MB");
    expect((await request.get(`/api/uploads/${id}`, { headers: ADMIN_AUTH })).status()).toBe(404);

    // The log is for an interactive session, which the signed-in page has and a token does not
    const audit = await (await page.request.get("/api/admin/audit")).json();
    expect(audit).toContainEqual(expect.objectContaining({ action: "upload_deleted", target: "floor-plan.png" }));
  });

  test("is the administrator's: a member can neither list nor delete, and the file stays", async ({ request }) => {
    const id = await upload(request, "keep.png");

    expect((await request.get("/api/organisation/storage/files", { headers: MEMBER_AUTH })).status()).toBe(403);
    expect((await request.delete(`/api/organisation/storage/files/${id}`, { headers: MEMBER_AUTH })).status()).toBe(403);
    expect((await request.get(`/api/uploads/${id}`, { headers: ADMIN_AUTH })).status()).toBe(200);
  });

  test("a token is refused, an administrator's too, so one on a worker's disk cannot empty the storage", async ({ request }) => {
    const id = await upload(request, "token.png");

    expect((await request.get("/api/organisation/storage/files", { headers: ADMIN_AUTH })).status()).toBe(403);
    expect((await request.delete(`/api/organisation/storage/files/${id}`, { headers: ADMIN_AUTH })).status()).toBe(403);
    expect((await request.get(`/api/uploads/${id}`, { headers: ADMIN_AUTH })).status()).toBe(200);
  });

  test("a file of another organisation is not found, so it cannot be deleted by naming its id", async ({ page }) => {
    const id = await storeElsewhere();
    await signIn(page);

    // A cookie session writes with the origin a browser would send, which is what the provenance check asks for
    expect((await page.request.delete(`/api/organisation/storage/files/${id}`, { headers: SAME_ORIGIN })).status()).toBe(404);
    expect(await withDb((db) => db.collection("uploads.files").countDocuments({ _id: new mongoose.Types.ObjectId(id) }))).toBe(1);
  });
});

function storeElsewhere(): Promise<string> {
  return storeByHand({ organisation: ELSEWHERE });
}
