import { test } from "@playwright/test";

test("hold the web servers until the mutation driver stops this run", async () => {
  await new Promise(() => {});
});
