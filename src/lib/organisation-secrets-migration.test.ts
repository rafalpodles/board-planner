import { describe, it, expect, vi, beforeAll } from "vitest";
import { Types } from "mongoose";
import type mongoose from "mongoose";

const ORGANISATION = new Types.ObjectId("0000000000000000000000a1");

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee";
});

async function v2(plaintext: string): Promise<string> {
  const crypto = await import("crypto");
  const material = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const id = crypto.createHash("sha256").update(material).digest("hex").slice(0, 8);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v2:${id}:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
}

function fakeConnection(rows: Record<string, Record<string, unknown>[]>, modifiedCount = 1) {
  const updateOne = vi.fn(async () => ({ modifiedCount }));
  const collection = (name: string) => ({
    find: () => ({
      async *[Symbol.asyncIterator]() {
        yield* rows[name] ?? [];
      },
    }),
    updateOne,
  });
  return { connection: { db: { collection } } as unknown as mongoose.Connection, updateOne };
}

describe("resealUnderOrganisationKeys (BP-898)", () => {
  it("writes only if every value it read is still there, and reports a row that changed meanwhile instead of counting it", async () => {
    const { resealUnderOrganisationKeys } = await import("./organisation-secrets-migration");
    const token = await v2("ghp");
    const { connection, updateOne } = fakeConnection({ projects: [{ _id: new Types.ObjectId(), organisation: ORGANISATION, githubToken: token }] }, 0);

    const report = await resealUnderOrganisationKeys(connection, { apply: true });

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: token }),
      { $set: { githubToken: expect.stringMatching(/^enc:v3:/) } }
    );
    expect(report.resealed).toBe(0);
    expect(report.needsAttention).toEqual([expect.stringMatching(/changed while this ran/)]);
  });

  it("leaves a row with no organisation, and plaintext and v3 values, alone", async () => {
    const { resealUnderOrganisationKeys } = await import("./organisation-secrets-migration");
    const { encryptSecret } = await import("./encryption");
    const { connection, updateOne } = fakeConnection({
      projects: [
        { _id: new Types.ObjectId(), githubToken: await v2("orphan") },
        { _id: new Types.ObjectId(), organisation: ORGANISATION, githubToken: "plain", codaToken: encryptSecret("x", ORGANISATION) },
      ],
    });

    const report = await resealUnderOrganisationKeys(connection, { apply: true });

    expect(updateOne).not.toHaveBeenCalled();
    expect(report.resealed).toBe(0);
    expect(report.needsAttention).toEqual([expect.stringMatching(/no organisation/)]);
  });
});
