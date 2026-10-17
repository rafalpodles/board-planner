import { join } from "node:path";
import {
  BASE_URL,
  ORGANISATIONS_PORT,
  PASSWORDLESS_BASE_URL,
  PROXIED_BASE_URL,
  RUN_AGAINST_PRODUCTION_BUILD,
  RUN_ORGANISATIONS_SERVER,
  RUN_PASSWORDLESS_SERVER,
  RUN_PROXIED_SERVER,
} from "../playwright.config";
import { resurrectLostRoutes } from "./dev-routes";

const APP_DIR = join(__dirname, "..", "src", "app");

export default async function globalSetup() {
  if (RUN_AGAINST_PRODUCTION_BUILD) return;

  const origins = [
    BASE_URL,
    ...(RUN_PROXIED_SERVER ? [PROXIED_BASE_URL] : []),
    ...(RUN_PASSWORDLESS_SERVER ? [PASSWORDLESS_BASE_URL] : []),
    ...(RUN_ORGANISATIONS_SERVER ? [`http://127.0.0.1:${ORGANISATIONS_PORT}`] : []),
  ];
  // Every server watches the same files, so a touch made for one can reach the others after they were
  // checked: go round again until a whole round touches nothing
  for (let round = 0; round < 3; round++) {
    let touched = false;
    for (const origin of origins) {
      const revived = await resurrectLostRoutes(origin, APP_DIR);
      if (revived.length === 0) continue;
      touched = true;
      console.warn(
        `::warning title=dev server lost routes::${origin} answered its 404 page for ${revived.length} route(s) of six segments or more and found them again once their files were touched (BP-1061): ${revived.join(", ")}`
      );
    }
    if (!touched) return;
  }
}
