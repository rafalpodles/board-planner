import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNotices, render } from "./third-party-notices.mjs";

let root: string;
let shipped: string;
let full: string;

function pkg(modules: string, path: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(modules, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "notices-"));
  shipped = join(root, "shipped");
  full = join(root, "full");
  mkdirSync(shipped);
  mkdirSync(full);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("collectNotices", () => {
  // The standalone build copies code and leaves the licence files behind (BP-944)
  it("reads the licence from the full tree for a package the shipped tree has no licence file for", () => {
    pkg(shipped, "left-pad", { name: "left-pad", version: "1.0.0" });
    pkg(full, "left-pad", { name: "left-pad", version: "1.0.0" }, { LICENSE: "MIT (c) Left Pad" });

    const { byText, without } = collectNotices(shipped, full);

    expect([...byText.entries()]).toEqual([["MIT (c) Left Pad", new Set(["left-pad@1.0.0"])]]);
    expect(without).toEqual([]);
  });

  it("lists only what the shipped tree holds, not everything in the full one", () => {
    pkg(shipped, "kept", { name: "kept", version: "1.0.0" });
    pkg(full, "kept", { name: "kept", version: "1.0.0" }, { LICENSE: "kept licence" });
    pkg(full, "dropped", { name: "dropped", version: "1.0.0" }, { LICENSE: "dropped licence" });

    const { byText } = collectNotices(shipped, full);

    expect([...byText.keys()]).toEqual(["kept licence"]);
  });

  it("finds scoped and nested packages", () => {
    pkg(shipped, "@scope/a", { name: "@scope/a", version: "2.0.0" }, { "LICENSE.md": "scoped licence" });
    pkg(shipped, "outer", { name: "outer", version: "1.0.0" }, { LICENSE: "outer licence" });
    pkg(shipped, "outer/node_modules/inner", { name: "inner", version: "3.0.0" }, { COPYING: "inner licence" });

    const { byText } = collectNotices(shipped);

    expect([...byText.values()].flatMap((labels) => [...labels]).sort()).toEqual([
      "@scope/a@2.0.0",
      "inner@3.0.0",
      "outer@1.0.0",
    ]);
  });

  it("groups identical licence texts under every package that has them", () => {
    pkg(shipped, "a", { name: "a", version: "1.0.0" }, { LICENSE: "same text\r\n" });
    pkg(shipped, "b", { name: "b", version: "1.0.0" }, { LICENSE: "same text" });

    const { byText } = collectNotices(shipped);

    expect(byText.size).toBe(1);
    expect([...byText.values()][0]).toEqual(new Set(["a@1.0.0", "b@1.0.0"]));
  });

  it("takes the licence files a package vendors inside itself, labelled by where they are", () => {
    pkg(shipped, "next", { name: "next", version: "16.0.0" }, {
      LICENSE: "next licence",
      "dist/compiled/acorn/LICENSE": "acorn licence",
    });

    const { byText } = collectNotices(shipped);

    expect([...byText.values()].flatMap((labels) => [...labels]).sort()).toEqual([
      "next@16.0.0",
      "next@16.0.0/dist/compiled/acorn",
    ]);
  });

  it("names a package with no licence file and what it declares, rather than dropping it", () => {
    pkg(shipped, "bare", { name: "bare", version: "0.0.1", license: "MIT" });
    pkg(shipped, "undeclared", { name: "undeclared", version: "0.0.2" });

    const { without } = collectNotices(shipped);

    expect(without).toEqual(["bare@0.0.1 (declares MIT)", "undeclared@0.0.2 (declares no licence)"]);
  });

  it("does not read the dot directories npm keeps in node_modules", () => {
    pkg(shipped, ".bin", { name: ".bin", version: "0.0.0" }, { LICENSE: "not a package" });
    pkg(shipped, "real", { name: "real", version: "1.0.0" }, { LICENSE: "real licence" });

    const { byText } = collectNotices(shipped);

    expect([...byText.keys()]).toEqual(["real licence"]);
  });
});

describe("render", () => {
  it("prints each licence once, with the packages that carry it", () => {
    pkg(shipped, "a", { name: "a", version: "1.0.0" }, { LICENSE: "MIT text" });
    pkg(shipped, "b", { name: "b", version: "2.0.0" }, { LICENSE: "MIT text" });
    pkg(shipped, "c", { name: "c", version: "3.0.0", license: "ISC" });

    const out = render(collectNotices(shipped));

    expect(out.match(/MIT text/g)).toHaveLength(1);
    expect(out).toContain("  a@1.0.0\n  b@2.0.0");
    expect(out).toContain("Packages that ship no licence file of their own:");
    expect(out).toContain("c@3.0.0 (declares ISC)");
  });
});
