#!/usr/bin/env node
// Writes the licence notices of the npm packages in a node_modules tree to stdout.
//
//   node scripts/third-party-notices.mjs <shipped node_modules> [<full node_modules>]
//
// Next's standalone output copies the code a server needs and none of the licence files beside it,
// so the packages are listed from the shipped tree and their licence text is read from the full one
// it was traced from (BP-944).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
const MAX_LICENCE_BYTES = 200_000;
const MAX_DEPTH = 6;

function packagesIn(nodeModules, found = []) {
  if (!existsSync(nodeModules)) return found;
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      packagesIn(dir, found);
      continue;
    }
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(manifest, "utf8"));
      } catch (error) {
        throw new Error(`${manifest}: ${error.message}`);
      }
      const { name, version, license, licenses, repository } = parsed;
      found.push({ name, version, declared: license ?? licenses, repository, dir });
    }
    packagesIn(join(dir, "node_modules"), found);
  }
  return found;
}

function licenceFilesIn(dir, base = dir, depth = 0, found = []) {
  if (!existsSync(dir) || depth > MAX_DEPTH) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") licenceFilesIn(path, base, depth + 1, found);
    } else if (entry.isFile() && LICENCE_FILE.test(entry.name) && statSync(path).size <= MAX_LICENCE_BYTES) {
      found.push({ path, within: dir === base ? "" : dir.slice(base.length + 1) });
    }
  }
  return found;
}

function repositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  return url ? url.replace(/^git\+/, "").replace(/\.git$/, "") : "see the package's repository";
}

function declaredName(declared) {
  if (!declared) return "no licence";
  if (typeof declared === "string") return declared;
  return [declared].flat().map((entry) => entry.type ?? String(entry)).join(" OR ");
}

export function collectNotices(shippedModules, fullModules = shippedModules) {
  const byText = new Map();
  const without = [];
  const lgpl = [];

  for (const pkg of packagesIn(shippedModules)) {
    const inFull = join(fullModules, relative(shippedModules, pkg.dir));
    const sourceDir = existsSync(inFull) ? inFull : pkg.dir;
    if (/LGPL/i.test(declaredName(pkg.declared))) {
      lgpl.push(`${pkg.name}@${pkg.version} — source: ${repositoryUrl(pkg.repository)}`);
    }
    const files = licenceFilesIn(sourceDir);
    if (files.length === 0) {
      without.push(`${pkg.name}@${pkg.version} (declares ${declaredName(pkg.declared)})`);
      continue;
    }
    for (const file of files) {
      const text = readFileSync(file.path, "utf8").replace(/\r\n/g, "\n").trim();
      if (!text) continue;
      const label = `${pkg.name}@${pkg.version}${file.within ? `/${file.within}` : ""}`;
      if (!byText.has(text)) byText.set(text, new Set());
      byText.get(text).add(label);
    }
  }
  return { byText, without, lgpl };
}

export function render({ byText, without, lgpl }) {
  const out = [
    "THIRD-PARTY NOTICES",
    "",
    "Board Planner is licensed under the GNU Affero General Public License v3.0 (see LICENSE). The",
    "npm packages below are included in this image, each under its own licence. This file is written",
    "at build time from the packages in the image; the base image (node:alpine) carries its own",
    "licence information.",
    "",
  ];
  const groups = [...byText.entries()]
    .map(([text, labels]) => ({ text, labels: [...labels].sort() }))
    .sort((a, b) => a.labels[0].localeCompare(b.labels[0]));
  for (const { text, labels } of groups) {
    out.push("================================================================================", "");
    out.push(...labels.map((label) => `  ${label}`), "", text, "");
  }
  if (lgpl.length > 0) {
    out.push("================================================================================", "");
    out.push("Packages under the GNU Lesser General Public License:", "");
    out.push(...lgpl.sort().map((line) => `  ${line}`), "");
    out.push(
      "The source of each is at the repository named above. Each sits in its own directory of this",
      "image, apart from the application, so a modified version can be put in its place. A package's",
      "README.md may list the libraries bundled in it and the licence of each (the @img/sharp-libvips",
      "packages do). The licence texts are at https://www.gnu.org/licenses/ (lgpl-3.0.txt, lgpl-2.1.txt).",
      ""
    );
  }
  if (without.length > 0) {
    out.push("================================================================================", "");
    out.push("Packages that ship no licence file of their own:", "", ...without.sort().map((line) => `  ${line}`), "");
  }
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [shipped, full] = process.argv.slice(2);
  if (!shipped) {
    console.error("usage: third-party-notices.mjs <shipped node_modules> [<full node_modules>]");
    process.exit(2);
  }
  const notices = collectNotices(shipped, full ?? shipped);
  if (notices.byText.size === 0) {
    console.error(`no licence files found for the packages in ${shipped}`);
    process.exit(1);
  }
  for (const line of notices.without) console.error(`no licence file: ${line}`);
  process.stdout.write(render(notices));
}
