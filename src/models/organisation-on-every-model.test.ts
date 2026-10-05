import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import "./all";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";
import { scopedModelNames, UNSCOPED_MODELS } from "@/lib/organisation-migration";

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
  "DeviceEnrolment.userCode": "short code typed on the verification page; looked up before the organisation is known",
  "EmailChangeToken.tokenHash": "random token",
  "Grant.subject+objectType+object": "subject and object are organisation-owned ids",
  "Invitation.tokenHash": "random token",
  "OAuthClient.clientId": "random id issued by /oauth/register; looked up by id alone on every cpat_ request",
  "OAuthCode.codeHash": "random code",
  "OAuthConsent.ticketHash": "random ticket",
  "OidcFlow.binderHash": "random cookie value",
  "PasswordResetToken.tokenHash": "random token",
  "PmOauthState.state": "random state",
  "PmTrigger.project+task": "project is an organisation-owned id",
  "AgentRun.task+runId+worker": "task is an organisation-owned id",
  "Session.tokenHash": "random token",
  "Organisation.slug": "the subdomain naming the organisation: unique across the platform by definition (BP-666)",
  "Task.project+taskNumber": "project is an organisation-owned id",
};

describe("every model carries an organisation", () => {
  it("registers one model per file in src/models", () => {
    expect(mongoose.modelNames()).toHaveLength(modelFiles.length);
  });

  it("imports every model file from all.ts", () => {
    const all = readFileSync(path.join(__dirname, "all.ts"), "utf8");
    for (const file of modelFiles) expect(all, file).toContain(`"./${file}"`);
  });

  it.each(scopedModelNames())("%s has a required, immutable organisation that nothing fills in for the writer", (name) => {
    const organisation = mongoose.model(name).schema.path("organisation");
    expect(organisation, `${name} is missing withOrganisation()`).toBeDefined();
    expect(organisation.isRequired).toBe(true);
    expect((organisation.options as { immutable?: boolean }).immutable).toBe(true);
    const unstamped = new (mongoose.model(name))();
    expect(unstamped.get("organisation")).toBeUndefined();
    expect(unstamped.validateSync()?.errors.organisation, name).toBeDefined();
  });

  it.each(UNSCOPED_MODELS)("%s is the exception and has no organisation", (name) => {
    expect(mongoose.model(name).schema.path("organisation")).toBeUndefined();
  });

  it("leaves no unique index global unless it is listed above", () => {
    const offenders = uniqueIndexes()
      .filter(({ keys }) => !keys.includes("organisation"))
      .map(idOf)
      .filter((id) => !GLOBAL_UNIQUE[id]);
    expect(offenders).toEqual([]);
  });

  it("lists no exception that no longer exists", () => {
    const declared = new Set(uniqueIndexes().map(idOf));
    expect(Object.keys(GLOBAL_UNIQUE).filter((id) => !declared.has(id))).toEqual([]);
  });

});
