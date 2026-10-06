import { expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ORGANISATIONS_PLATFORM_ORIGIN } from "../playwright.config";
import { E2E_MONGODB_URI } from "./seed";
import { mailFor } from "./mailbox";
import { ORGANISATIONS_API, PLATFORM_HOST, type OrganisationFixture } from "./organisations";

export const onPlatform = { host: PLATFORM_HOST, "sec-fetch-site": "same-origin" };

export async function withDb<T>(work: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await work(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

export const giveAddress = (who: OrganisationFixture, email: string, emailVerifiedAt: Date | null = new Date()) =>
  withDb((db) => db.collection("users").updateOne({ _id: who.adminId }, { $set: { email, emailVerifiedAt } }));

let sequence = 0;
export const freshAddress = (name: string) => `${name}-${Date.now()}-${sequence++}@people.example`;

export async function codeSentTo(email: string, previous = 0): Promise<string> {
  let code = "";
  await expect
    .poll(async () => {
      const messages = await mailFor(email);
      const match = messages.length > previous ? /(\d{6}) is your/.exec(messages[messages.length - 1].data) : null;
      code = match?.[1] ?? "";
      return code;
    })
    .toMatch(/^\d{6}$/);
  return code;
}

export async function provideAddressAndCode(page: Page, email: string) {
  const before = (await mailFor(email)).length;
  await page.goto(`${ORGANISATIONS_PLATFORM_ORIGIN}/`);
  await page.getByLabel("E-mail address").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(`We sent a code to ${email}`)).toBeVisible();
  await page.getByLabel("Code").fill(await codeSentTo(email, before));
  await page.getByRole("button", { name: "Continue" }).click();
}

// The cookie is Secure, which a browser sends to *.localhost and an API client never sends over http
export async function apiCode(request: APIRequestContext, email: string): Promise<Record<string, string>> {
  const before = (await mailFor(email)).length;
  const started = await request.post(`${ORGANISATIONS_API}/api/sign-in/start`, { headers: onPlatform, data: { email } });
  expect(started.status()).toBe(200);
  const binder = /bp_platform_signin=([^;]+)/.exec(started.headers()["set-cookie"] ?? "")![1];
  const withBinder = { ...onPlatform, cookie: `__Host-bp_platform_signin=${binder}` };
  const code = await codeSentTo(email, before);
  expect((await request.post(`${ORGANISATIONS_API}/api/sign-in/verify`, { headers: withBinder, data: { code } })).status()).toBe(200);
  return withBinder;
}

