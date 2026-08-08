import { wipe } from "./seed";

export default async function globalTeardown() {
  if (process.env.E2E_KEEP_DATA === "1") return;
  await wipe();
}
