import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, startPort } from "../../scripts/start-port.mjs";

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bp-start-port-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// BP-775. `next start` binds before it reads .env, so a PORT there never moved it.
describe("the port npm start listens on", () => {
  it("takes PORT from .env when the environment has none", () => {
    expect(startPort(project({ ".env": "MONGODB_URI=mongodb://x\nPORT=4567\n" }), {})).toBe("4567");
  });

  it("lets the environment win, the way Railway and Docker set it", () => {
    expect(startPort(project({ ".env": "PORT=4567\n" }), { PORT: "8080" })).toBe("8080");
  });

  it("reads the files in the order Next does", () => {
    const dir = project({ ".env": "PORT=1111\n", ".env.production": "PORT=2222\n", ".env.local": "PORT=3333\n" });

    expect(startPort(dir, {})).toBe("3333");
  });

  it("stays on 3000 when nothing names a port", () => {
    expect(startPort(project({ ".env": "MONGODB_URI=mongodb://x\n" }), {})).toBe(DEFAULT_PORT);
    expect(startPort(project({}), { PORT: " " })).toBe("3000");
  });
});
