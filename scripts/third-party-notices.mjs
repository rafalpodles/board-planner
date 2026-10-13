#!/usr/bin/env node
// Writes the licence notices of a project's production npm dependencies to stdout.
//
//   node scripts/third-party-notices.mjs [<project root>]
//
// The packages come from package-lock.json (everything not marked dev), their licence texts from
// the installed node_modules. Next compiles most server dependencies into its own chunks and the
// standalone output keeps neither those nor the licence files of the rest, so the shipped
// node_modules cannot be the list (BP-944).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
const CODE_FILE = /\.(m?js|cjs|ts|json)$/i;
const MAX_LICENCE_BYTES = 200_000;
const MAX_DEPTH = 6;

function readManifest(dir) {
  const manifest = join(dir, "package.json");
  try {
    return JSON.parse(readFileSync(manifest, "utf8"));
  } catch (error) {
    throw new Error(`${manifest}: ${error.message}`);
  }
}

function licenceFilesIn(dir, base = dir, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") licenceFilesIn(path, base, depth + 1, found);
    } else if (
      entry.isFile() &&
      LICENCE_FILE.test(entry.name) &&
      !CODE_FILE.test(entry.name) &&
      statSync(path).size <= MAX_LICENCE_BYTES
    ) {
      found.push({ path, within: relative(base, dir) });
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
  return [declared].flat().map((entry) => entry?.type ?? String(entry)).join(" OR ");
}

export function collectNotices(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const byText = new Map();
  const without = [];
  const lgpl = [];

  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    // "" is the project itself
    if (!key || entry.dev || entry.link) continue;
    const dir = join(root, key);
    // The lockfile names every platform's build of an optional package; npm installs the one that fits
    if (!existsSync(join(dir, "package.json"))) continue;

    const { name, version, license, licenses, repository } = readManifest(dir);
    const declared = license ?? licenses;
    const label = `${name}@${version}`;
    if (/LGPL/i.test(declaredName(declared))) lgpl.push(`${label} — source: ${repositoryUrl(repository)}`);

    const files = licenceFilesIn(dir);
    if (files.length === 0) {
      without.push(`${label} (declares ${declaredName(declared)})`);
      continue;
    }
    for (const file of files) {
      const text = readFileSync(file.path, "utf8").replace(/\r\n/g, "\n").trim();
      if (!text) continue;
      const where = file.within ? `${label}/${file.within}` : label;
      if (!byText.has(text)) byText.set(text, new Set());
      byText.get(text).add(where);
    }
  }
  return { byText, without, lgpl };
}

export function render({ byText, without, lgpl }) {
  const rule = "================================================================================";
  const out = [
    "THIRD-PARTY NOTICES",
    "",
    "Board Planner is licensed under the GNU Affero General Public License v3.0 (see LICENSE). It is",
    "built from the npm packages below, each under its own licence: some are compiled into the",
    "application's own files, some are loaded from node_modules at run time and some are used only to",
    "build it. This file is written at build time from the project's package-lock.json; the base image",
    "(node:alpine) carries its own licence information.",
    "",
  ];
  const groups = [...byText.entries()]
    .map(([text, labels]) => ({ text, labels: [...labels].sort() }))
    .sort((a, b) => a.labels[0].localeCompare(b.labels[0]));
  for (const { text, labels } of groups) {
    out.push(rule, "", ...labels.map((label) => `  ${label}`), "", text, "");
  }
  if (lgpl.length > 0) {
    out.push(rule, "", "Packages under the GNU Lesser General Public License:", "");
    out.push(...lgpl.sort().map((line) => `  ${line}`), "");
    out.push(
      "The repository named is the package's own (for @img/sharp-libvips, the scripts that build the",
      "libraries it carries). A package's README.md may list the libraries bundled in it and the licence",
      "of each, and its versions.json their versions: the upstream source is the release of that",
      "version (the @img/sharp-libvips packages do both). Where a package is loaded from node_modules at",
      "run time, a modified version can be put in its place in this image. The text of the GNU LGPL",
      "version 3 and of the GNU GPL version 3 it incorporates is in the licenses directory of this",
      "image; other versions are at https://www.gnu.org/licenses/.",
      ""
    );
  }
  if (without.length > 0) {
    out.push(rule, "", "Packages that ship no licence file of their own:", "");
    out.push(...without.sort().map((line) => `  ${line}`), "");
  }
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? ".";
  if (!existsSync(join(root, "package-lock.json"))) {
    console.error(`no package-lock.json in ${root}`);
    process.exit(2);
  }
  const notices = collectNotices(root);
  if (notices.byText.size === 0) {
    console.error(`no licence files found for the packages in ${root}`);
    process.exit(1);
  }
  for (const line of notices.without) console.error(`no licence file: ${line}`);
  process.stdout.write(render(notices));
}
