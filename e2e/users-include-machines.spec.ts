import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { SAME_ORIGIN } from "./api";
import { ADMIN_USERNAME, E2E_MONGODB_URI, MEMBER_USERNAME, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-718. Since BP-713 removed `GET /api/users/[userId]`, the list was the only route returning a
 * user document, and it leaves machines out. `?include=machines` is the opt-in; the screen keeps
 * the default.
 */

const MACHINES = [
  {
    _id: new mongoose.Types.ObjectId("e2e00000000000000000a718"),
    username: "pm",
    fullName: "PM Agent",
  },
  {
    _id: new mongoose.Types.ObjectId("e2e00000000000000000a719"),
    username: "worker-e2e718",
    fullName: "Owner · e2e machine",
  },
];

test.beforeEach(async () => {
  await seed();
  await mongoose.connect(E2E_MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");
  await db.collection("users").insertMany(
    MACHINES.map((m) => ({
      ...m,
      password: "not-a-bcrypt-hash",
      email: "",
      role: "member",
      kind: "machine",
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  await mongoose.disconnect();
});

const usernames = (body: { username: string }[]) => body.map((u) => u.username);

test("the users screen still lists people only", async ({ page }) => {
  await signIn(page, "admin");
  const listed = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === "/api/users" &&
      res.request().method() === "GET",
  );
  await page.goto("/settings/users");
  const response = await listed;

  expect(new URL(response.url()).searchParams.get("include")).toBeNull();
  expect(usernames(await response.json())).not.toContain("pm");
  await expect(
    page.getByText(`@${MEMBER_USERNAME}`, { exact: true }),
  ).toBeVisible();
  for (const machine of MACHINES) {
    await expect(
      page.getByText(`@${machine.username}`, { exact: true }),
    ).toHaveCount(0);
  }
});

test("an admin who asks for machines is given pm and the worker alongside the people", async ({
  page,
}) => {
  await signIn(page, "admin");
  await page.goto("/settings/users");

  const response = await page.request.get("/api/users?include=machines", {
    headers: SAME_ORIGIN,
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(usernames(body)).toEqual(
    expect.arrayContaining([
      ADMIN_USERNAME,
      MEMBER_USERNAME,
      "pm",
      "worker-e2e718",
    ]),
  );
  for (const machine of MACHINES) {
    const row = body.find(
      (u: { username: string }) => u.username === machine.username,
    );
    expect(row).toMatchObject({
      _id: machine._id.toString(),
      kind: "machine",
      role: "member",
    });
    expect(row.password).toBeUndefined();
  }
});

test("a member asking for machines is refused", async ({ page }) => {
  await signIn(page, "member");
  await page.goto("/projects");
  const response = await page.request.get("/api/users?include=machines", {
    headers: SAME_ORIGIN,
  });
  expect(response.status()).toBe(403);
});
