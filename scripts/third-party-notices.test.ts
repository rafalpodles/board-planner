import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNotices, render } from "./third-party-notices.mjs";

const SCRIPT = join(__dirname, "third-party-notices.mjs");

let root: string;
let lockPackages: Record<string, unknown>;

// A project root with a package-lock.json that lists what `pkg` installs
function pkg(
  path: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
  lock: Record<string, unknown> = {}
) {
  const dir = join(root, "node_modules", path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  lockPackages[`node_modules/${path}`] = { version: manifest.version, ...lock };
  writeLock();
}

function writeLock() {
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...lockPackages } }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "notices-"));
  lockPackages = {};
  writeLock();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("collectNotices", () => {
  // Next compiles most server dependencies into its own chunks, so the shipped node_modules holds
  // 27 of the application's ~100 production packages (BP-944)
  it("reads a lockfile package's licence from its installed directory", () => {
    pkg("left-pad", { name: "left-pad", version: "1.0.0" }, { LICENSE: "MIT (c) Left Pad" });

    const { byText, without } = collectNotices(root);

    expect([...byText.entries()]).toEqual([["MIT (c) Left Pad", new Set(["left-pad@1.0.0"])]]);
    expect(without).toEqual([]);
  });

  it("leaves out dev dependencies", () => {
    pkg("kept", { name: "kept", version: "1.0.0" }, { LICENSE: "kept licence" });
    pkg("tooling", { name: "tooling", version: "1.0.0" }, { LICENSE: "tooling licence" }, { dev: true });

    expect([...collectNotices(root).byText.keys()]).toEqual(["kept licence"]);
  });

  it("leaves out a package of another platform's build that is in the lockfile and not installed", () => {
    pkg("here", { name: "here", version: "1.0.0" }, { LICENSE: "here licence" });
    lockPackages["node_modules/@img/sharp-darwin-arm64"] = { version: "0.35.5", optional: true };
    writeLock();

    const { byText, without } = collectNotices(root);

    expect([...byText.keys()]).toEqual(["here licence"]);
    expect(without).toEqual([]);
  });

  it("finds scoped and nested packages by their lockfile path", () => {
    pkg("@scope/a", { name: "@scope/a", version: "2.0.0" }, { "LICENSE.md": "scoped licence" });
    pkg("outer", { name: "outer", version: "1.0.0" }, { LICENSE: "outer licence" });
    pkg("outer/node_modules/inner", { name: "inner", version: "3.0.0" }, { COPYING: "inner licence" });

    const { byText } = collectNotices(root);

    expect([...byText.values()].flatMap((labels) => [...labels]).sort()).toEqual([
      "@scope/a@2.0.0",
      "inner@3.0.0",
      "outer@1.0.0",
    ]);
  });

  it("groups identical licence texts under every package that has them", () => {
    pkg("a", { name: "a", version: "1.0.0" }, { LICENSE: "line one\r\nline two" });
    pkg("b", { name: "b", version: "1.0.0" }, { LICENSE: "line one\nline two" });

    const { byText } = collectNotices(root);

    expect(byText.size).toBe(1);
    expect([...byText.values()][0]).toEqual(new Set(["a@1.0.0", "b@1.0.0"]));
  });

  it("takes the licence files a package vendors inside itself, labelled by where they are", () => {
    pkg(
      "next",
      { name: "next", version: "16.0.0" },
      { LICENSE: "next licence", "dist/compiled/acorn/LICENSE": "acorn licence" }
    );

    const { byText } = collectNotices(root);

    expect([...byText.values()].flatMap((labels) => [...labels]).sort()).toEqual([
      "next@16.0.0",
      "next@16.0.0/dist/compiled/acorn",
    ]);
  });

  it("does not take a source file for a licence because of its name", () => {
    pkg("odd", { name: "odd", version: "1.0.0", license: "MIT" }, { "license.js": "module.exports = 1", "notice.d.ts": "x" });

    expect(collectNotices(root).without).toEqual(["odd@1.0.0 (declares MIT)"]);
  });

  it("names a package with no licence file and what it declares, rather than dropping it", () => {
    pkg("bare", { name: "bare", version: "0.0.1", license: "MIT" });
    pkg("undeclared", { name: "undeclared", version: "0.0.2" });

    expect(collectNotices(root).without).toEqual(["bare@0.0.1 (declares MIT)", "undeclared@0.0.2 (declares no licence)"]);
  });

  it("lists an LGPL package with where its source is", () => {
    pkg("@img/libvips", {
      name: "@img/libvips",
      version: "1.3.4",
      license: "LGPL-3.0-or-later",
      repository: { url: "git+https://github.com/lovell/sharp-libvips.git" },
    });

    expect(collectNotices(root).lgpl).toEqual(["@img/libvips@1.3.4 — source: https://github.com/lovell/sharp-libvips"]);
  });

  it("lists an LGPL package that does ship a licence file too, and reads that file", () => {
    pkg("lib", { name: "lib", version: "2.0.0", license: "LGPL-2.1" }, { COPYING: "lgpl text" });

    const { byText, lgpl } = collectNotices(root);

    expect(lgpl).toEqual(["lib@2.0.0 — source: see the package's repository"]);
    expect([...byText.keys()]).toEqual(["lgpl text"]);
  });

  it("passes over a licence file that is a dangling link instead of failing the build", () => {
    pkg("linked", { name: "linked", version: "1.0.0", license: "MIT" });
    symlinkSync(join(root, "nowhere"), join(root, "node_modules", "linked", "LICENSE"));

    expect(collectNotices(root).without).toEqual(["linked@1.0.0 (declares MIT)"]);
  });

  it("names the file when a package.json cannot be read", () => {
    pkg("broken", { name: "broken", version: "1.0.0" });
    writeFileSync(join(root, "node_modules", "broken", "package.json"), "{ not json");

    expect(() => collectNotices(root)).toThrow(/broken\/package\.json/);
  });
});

describe("render", () => {
  it("prints each licence once, with the packages that carry it", () => {
    pkg("a", { name: "a", version: "1.0.0" }, { LICENSE: "MIT text" });
    pkg("b", { name: "b", version: "2.0.0" }, { LICENSE: "MIT text" });
    pkg("c", { name: "c", version: "3.0.0", license: "ISC" });

    const out = render(collectNotices(root));

    expect(out.match(/MIT text/g)).toHaveLength(1);
    expect(out).toContain("  a@1.0.0\n  b@2.0.0");
    expect(out).toContain("Packages that ship no licence file of their own:");
    expect(out).toContain("c@3.0.0 (declares ISC)");
    expect(out).not.toContain("Lesser General Public License");
  });

  it("orders the groups by their first package, whatever order they were found in", () => {
    pkg("a-dir", { name: "zeta", version: "1.0.0" }, { LICENSE: "text of zeta" });
    pkg("z-dir", { name: "alpha", version: "1.0.0" }, { LICENSE: "text of alpha" });

    const out = render(collectNotices(root));

    expect(out.indexOf("text of alpha")).toBeLessThan(out.indexOf("text of zeta"));
  });

  it("says what the LGPL asks to be said", () => {
    pkg("lib", { name: "lib", version: "1.0.0", license: "LGPL-3.0-or-later" });

    const out = render(collectNotices(root));

    expect(out).toContain("Packages under the GNU Lesser General Public License");
    expect(out).toContain("a modified version can be put in its place");
  });
});

describe("as a command", () => {
  const run = (...args: string[]) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { status: (error as { status: number }).status, stdout: "" };
    }
  };

  it("writes the notices of the project it is pointed at", () => {
    pkg("a", { name: "a", version: "1.0.0" }, { LICENSE: "licence of a" });

    const { status, stdout } = run(root);

    expect(status).toBe(0);
    expect(stdout).toContain("THIRD-PARTY NOTICES");
    expect(stdout).toContain("licence of a");
  });

  it("exits 2 with no lockfile and 1 when no licence text was found at all", () => {
    pkg("bare", { name: "bare", version: "1.0.0", license: "MIT" });

    expect(run(root).status).toBe(1);
    expect(run(join(root, "node_modules")).status).toBe(2);
  });
});
