import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import "./all";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";
import { scopedModelNames, UNSCOPED_MODELS } from "@/lib/tenant-migration";

const modelFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "all.ts")
  .map((f) => f.replace(/\.ts$/, ""));

const uniqueIndexes = () =>
  mongoose.modelNames().flatMap((model) =>
    mongoose
      .model(model)
      .schema.indexes()
      .filter(([, options]) => options?.unique)
      .map(([fields]) => ({ model, keys: Object.keys(fields) }))
  );

const idOf = ({ model, keys }: { model: string; keys: string[] }) => `${model}.${keys.join("+")}`;

const GLOBAL_UNIQUE: Record<string, string> = {
  "DeviceEnrolment.deviceCodeHash": "random device code",
  "DeviceEnrolment.userCode": "short code typed on the verification page; looked up before the tenant is known",
  "EmailChangeToken.tokenHash": "random token",
  "Grant.subject+objectType+object": "subject and object are tenant-owned ids",
  "Invitation.tokenHash": "random token",
  "OAuthClient.clientId": "random id issued by /oauth/register; looked up by id alone on every cpat_ request",
  "OAuthCode.codeHash": "random code",
  "OAuthConsent.ticketHash": "random ticket",
  "OidcFlow.binderHash": "random cookie value",
  "PasswordResetToken.tokenHash": "random token",
  "PmOauthState.state": "random state",
  "PmTrigger.project+task": "project is a tenant-owned id",
  "AgentRun.task+runId+worker": "task is a tenant-owned id",
  "Session.tokenHash": "random token",
  "Task.project+taskNumber": "project is a tenant-owned id",
  "User.username": "TODO(BP-665): global until a second tenant can exist",
  "User.email": "TODO(BP-665): global until a second tenant can exist",
  "Project.key": "TODO(BP-665): global until a second tenant can exist",
  "Worker.name+host": "TODO(BP-665): global until a second tenant can exist",
  "Identity.issuer+subject": "TODO(BP-665): global until a second tenant can exist",
  "Invitation.email": "TODO(BP-665): global until a second tenant can exist",
  "AgentBlock.key": "TODO(BP-665): global until a second tenant can exist",
};

describe("every model carries a tenant", () => {
  it("registers one model per file in src/models", () => {
    expect(mongoose.modelNames()).toHaveLength(modelFiles.length);
  });

  it("imports every model file from all.ts", () => {
    const all = readFileSync(path.join(__dirname, "all.ts"), "utf8");
    for (const file of modelFiles) expect(all, file).toContain(`"./${file}"`);
  });

  it.each(scopedModelNames())("%s has a required, immutable tenant that nothing fills in for the writer", (name) => {
    const tenant = mongoose.model(name).schema.path("tenant");
    expect(tenant, `${name} is missing withTenant()`).toBeDefined();
    expect(tenant.isRequired).toBe(true);
    expect((tenant.options as { immutable?: boolean }).immutable).toBe(true);
    const unstamped = new (mongoose.model(name))();
    expect(unstamped.get("tenant")).toBeUndefined();
    expect(unstamped.validateSync()?.errors.tenant, name).toBeDefined();
  });

  it.each(UNSCOPED_MODELS)("%s is the exception and has no tenant", (name) => {
    expect(mongoose.model(name).schema.path("tenant")).toBeUndefined();
  });

  it("leaves no unique index global unless it is listed above", () => {
    const offenders = uniqueIndexes()
      .filter(({ keys }) => !keys.includes("tenant"))
      .map(idOf)
      .filter((id) => !GLOBAL_UNIQUE[id]);
    expect(offenders).toEqual([]);
  });

  it("lists no exception that no longer exists", () => {
    const declared = new Set(uniqueIndexes().map(idOf));
    expect(Object.keys(GLOBAL_UNIQUE).filter((id) => !declared.has(id))).toEqual([]);
  });

  it("gives every global unique that will go a per-tenant twin that leads with the same fields", () => {
    const all = uniqueIndexes();
    const waiting = all.filter((index) => GLOBAL_UNIQUE[idOf(index)]?.startsWith("TODO(BP-665)"));
    const twinless = waiting.filter(
      ({ model, keys }) =>
        !all.some((other) => other.model === model && other.keys.join() === [...keys, "tenant"].join())
    );
    expect(twinless.map(idOf)).toEqual([]);
  });
});
