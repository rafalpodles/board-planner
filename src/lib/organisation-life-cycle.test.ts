import { describe, it, expect } from "vitest";
import "@/models/all";
import { SCOPED_MODELS } from "./db-scope";
import { scopedModelNames } from "./organisation-migration";
import { NOT_EXPORTED } from "./organisation-life-cycle";

describe("an organisation's export and delete cover every model it has (BP-893)", () => {
  it("can reach every scoped model through the scoped db, so delete and export miss none", () => {
    expect(scopedModelNames().filter((name) => !Object.hasOwn(SCOPED_MODELS, name))).toEqual([]);
  });

  it("leaves out of the export only real models, each with a reason", () => {
    for (const [name, reason] of Object.entries(NOT_EXPORTED)) {
      expect(scopedModelNames(), name).toContain(name);
      expect(reason.length, name).toBeGreaterThan(0);
    }
  });
});

describe("what an export row keeps (BP-893)", () => {
  it("drops passwords, token hashes and every stored secret, nested ones included, and keeps the rest", async () => {
    const { exportableRow } = await import("./organisation-life-cycle");
    const project = exportableRow("Project", {
      name: "Rockets",
      githubToken: "enc:v3:k:aaa",
      notificationChannels: [{ name: "Releases", webhookUrl: "enc:v3:k:bbb" }],
      pm: { mcpServers: [{ name: "tracker", authToken: "enc:v3:k:ccc", oauth: { clientId: "id", accessToken: "enc:v3:k:ddd" } }] },
    });
    const user = exportableRow("User", { username: "boss", password: "$2b$...", notifications: { chat: { kind: "slack", webhookUrl: "enc:v3:k:eee" } } });
    const token = exportableRow("ApiToken", { name: "ci", tokenHash: "f00", prefix: "cp_abc" });

    expect(JSON.stringify([project, user, token])).not.toMatch(/enc:v3|\$2b|f00/);
    expect(project).toEqual({
      name: "Rockets",
      notificationChannels: [{ name: "Releases" }],
      pm: { mcpServers: [{ name: "tracker", oauth: { clientId: "id" } }] },
    });
    expect(user).toEqual({ username: "boss", notifications: { chat: { kind: "slack" } } });
    expect(token).toEqual({ name: "ci", prefix: "cp_abc" });
  });
});

describe("the fields an export reads although the schema hides them (BP-893)", () => {
  it("reaches into subdocuments, so a task's decision, its patch and its attempts are not lost", async () => {
    const { hiddenPaths } = await import("./organisation-life-cycle");

    expect(hiddenPaths("Task")).toEqual(
      expect.arrayContaining(["+decision.files", "+decision.protectedFiles", "+decision.patch", "+decision.patchSha256", "+decision.attempts"])
    );
    expect(hiddenPaths("Worker")).toContain("+credentialHash");
  });
});
