import { readdirSync, statSync, utimesSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Measured on Linux with Next 16.3.8 (BP-1061): routes of six segments or more are lost, shallower ones are not
export const DEEP_ROUTE_SEGMENTS = 6;

const PROBE_TIMEOUT_MS = 60_000;

export interface DeepRoute {
  file: string;
  url: string;
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

export function urlOfRoute(segments: string[]): string {
  const parts = segments.map((segment) =>
    segment.startsWith("[...") ? "x/y" : segment.startsWith("[") ? "x" : segment
  );
  return `/${parts.join("/")}`;
}

export function deepRoutes(appDir: string, depth = DEEP_ROUTE_SEGMENTS): DeepRoute[] {
  return routeFiles(appDir).flatMap((file) => {
    const segments = relative(appDir, file).split(sep).slice(0, -1);
    return segments.length >= depth ? [{ file, url: urlOfRoute(segments) }] : [];
  });
}

async function isLost(origin: string, url: string): Promise<boolean> {
  try {
    const response = await fetch(origin + url, { method: "OPTIONS", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.text();
    return response.status === 404 && (response.headers.get("content-type") ?? "").includes("html");
  } catch (error) {
    throw new Error(`OPTIONS ${origin}${url} did not answer: ${error instanceof Error ? error.message : error}`);
  }
}

export async function resurrectLostRoutes(
  origin: string,
  appDir: string,
  { attempts = 10, settleMs = 2_000 }: { attempts?: number; settleMs?: number } = {}
): Promise<string[]> {
  const routes = deepRoutes(appDir);
  const revived = new Set<string>();
  let pending = routes;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    const lost: DeepRoute[] = [];
    for (const route of pending) {
      if (await isLost(origin, route.url)) lost.push(route);
    }
    if (lost.length === 0) return [...revived];
    if (attempt === attempts) {
      throw new Error(
        `The dev server at ${origin} still answers its HTML 404 for ${lost.length} route(s) after ${attempts} nudges:\n${lost
          .map((route) => route.url)
          .join("\n")}`
      );
    }
    const now = new Date();
    for (const route of lost) {
      utimesSync(route.file, now, now);
      revived.add(route.url);
    }
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    pending = lost;
  }
  return [...revived];
}
