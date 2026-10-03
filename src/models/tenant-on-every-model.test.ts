import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import "./all";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";
import { SINGLETON_ID } from "@/lib/singleton";

const modelFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "all.ts")
  .map((f) => f.replace(/\.ts$/, ""));

const scoped = () => mongoose.modelNames().filter((name) => name !== "Tenant");

// Unique indexes that are global on purpose. Each is a random secret or a key that already
// names its own tenant; a unique index on anything a person chooses (a name, a key, an address)
// belongs under the tenant, or two tenants could not both use it.
const GLOBAL_UNIQUE: Record<string, string> = {
  "DeviceEnrolment.deviceCodeHash": "random device code",
  "DeviceEnrolment.userCode": "short code typed on the verification page; looked up before the tenant is known",
  "EmailChangeToken.tokenHash": "random token",
  "Grant.subject+objectType+object": "subject and object are tenant-owned ids",
  "Invitation.tokenHash": "random token",
  "OAuthCode.codeHash": "random code",
  "OAuthConsent.ticketHash": "random ticket",
  "OidcFlow.binderHash": "random cookie value",
  "PasswordResetToken.tokenHash": "random token",
  "PmOauthState.state": "random state",
  "PmTrigger.project+task": "project is a tenant-owned id",
  "AgentRun.task+runId+worker": "task is a tenant-owned id",
  "Session.tokenHash": "random token",
  "Task.project+taskNumber": "project is a tenant-owned id",
};

describe("every model carries a tenant", () => {
  it("uses the id upsertSingleton gives the one Tenant row as the default tenant", () => {
    expect(String(DEFAULT_TENANT_ID)).toBe(String(SINGLETON_ID));
  });

  it("registers one model per file in src/models", () => {
    expect(mongoose.modelNames()).toHaveLength(modelFiles.length);
  });

  it("imports every model file from all.ts", () => {
    const all = readFileSync(path.join(__dirname, "all.ts"), "utf8");
    for (const file of modelFiles) expect(all, file).toContain(`"./${file}"`);
  });

  it.each(scoped())("%s has a required tenant that defaults to the default tenant", (name) => {
    const path = mongoose.model(name).schema.path("tenant");
    expect(path, `${name} is missing withTenant()`).toBeDefined();
    expect(path.isRequired).toBe(true);
    const fallback = (path as unknown as { getDefault: () => unknown }).getDefault();
    expect(String(fallback)).toBe(String(DEFAULT_TENANT_ID));
  });

  it("leaves no unique index global unless it is listed above", () => {
    const offenders: string[] = [];
    for (const name of scoped()) {
      for (const [fields, options] of mongoose.model(name).schema.indexes()) {
        if (!options?.unique) continue;
        const keys = Object.keys(fields);
        if (keys[0] === "tenant") continue;
        const id = `${name}.${keys.join("+")}`;
        if (!GLOBAL_UNIQUE[id]) offenders.push(id);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lists no exception that no longer exists", () => {
    const declared = new Set<string>();
    for (const name of scoped()) {
      for (const [fields, options] of mongoose.model(name).schema.indexes()) {
        if (options?.unique) declared.add(`${name}.${Object.keys(fields).join("+")}`);
      }
    }
    expect(Object.keys(GLOBAL_UNIQUE).filter((id) => !declared.has(id))).toEqual([]);
  });
});
