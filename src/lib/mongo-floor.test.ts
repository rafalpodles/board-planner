import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const NEWER_THAN_THE_FLOOR = new Set([
  "$bitAnd", "$bitNot", "$bitOr", "$bitXor", "$bottom", "$bottomN", "$covariancePop", "$covarianceSamp",
  "$dateAdd", "$dateDiff", "$dateSubtract", "$dateTrunc", "$denseRank", "$densify", "$derivative", "$documentNumber",
  "$expMovingAvg", "$fill", "$firstN", "$getField", "$integral", "$lastN", "$linearFill", "$locf", "$maxN",
  "$median", "$minN", "$percentile", "$rank", "$setField", "$setWindowFields", "$shift", "$sortArray", "$top", "$topN",
  "$tsIncrement", "$tsSecond", "$unsetField",
]);

const LOOKUP_MIXING = "$lookup with localField and pipeline";

const propertyName = (node: ts.ObjectLiteralElementLike) =>
  node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : undefined;

function mixesLookup(node: ts.PropertyAssignment) {
  if (propertyName(node) !== "$lookup" || !ts.isObjectLiteralExpression(node.initializer)) return false;
  const names = node.initializer.properties.map(propertyName);
  return names.includes("localField") && names.includes("pipeline");
}

function newerThanTheFloor(source: string, fileName = "source.ts"): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && NEWER_THAN_THE_FLOOR.has(node.text)) found.add(node.text);
    if (ts.isIdentifier(node) && NEWER_THAN_THE_FLOOR.has(node.text)) found.add(node.text);
    if (ts.isPropertyAssignment(node) && mixesLookup(node)) found.add(LOOKUP_MIXING);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest));
  return [...found].sort();
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const mongoImages = (file: string) => [...readFileSync(join(ROOT, file), "utf8").matchAll(/image: (mongo:\S+)/g)].map((match) => match[1]);

describe("the scan", () => {
  it.each([
    ["a stage", `[{ $setWindowFields: {} }]`, ["$setWindowFields"]],
    ["a quoted key", `({ "$dateTrunc": {} })`, ["$dateTrunc"]],
    ["a name held in a string", `const op = "$dateDiff"; const other = \`$top\`;`, ["$dateDiff", "$top"]],
    ["a shorthand property", `({ $dateAdd })`, ["$dateAdd"]],
    ["a lookup mixing its two forms", `({ $lookup: { from: "a", localField: "b", foreignField: "c", pipeline: [], as: "d" } })`, [LOOKUP_MIXING]],
    ["JSX", `const a = <p title="$dateTrunc" />;`, ["$dateTrunc"]],
  ])("finds %s", (_name, source, found) => {
    expect(newerThanTheFloor(source, "source.tsx")).toEqual(found);
  });

  it.each([
    ["a comment", `// $dateTrunc\n/* $setWindowFields */ const a = 1;`],
    ["prose in a string", `const a = "use $dateTrunc on 5.0";`],
    ["what the floor has", `[{ $unionWith: "a" }, { $lookup: { from: "a", let: {}, pipeline: [], as: "b" } }, { $count: "n" }]`],
    ["a lookup with one form", `({ $lookup: { from: "a", localField: "b", foreignField: "c", as: "d" } })`],
  ])("passes %s", (_name, source) => {
    expect(newerThanTheFloor(source)).toEqual([]);
  });
});

describe("the MongoDB floor", () => {
  it("names nothing a 4.4 server refuses", () => {
    const offending = ["src", "scripts"].flatMap((dir) => sources(join(ROOT, dir))).flatMap((file) =>
      newerThanTheFloor(readFileSync(file, "utf8"), file).map((name) => `${relative(ROOT, file)}: ${name}`),
    );
    expect(offending).toEqual([]);
  }, 30_000);

  it("is the server the e2e jobs run on", () => {
    const [floor] = mongoImages("docker-compose.yml");
    expect(floor).toBe("mongo:4.4");
    expect(new Set(["ci.yml", "mutation-check.yml"].flatMap((name) => mongoImages(`.github/workflows/${name}`)))).toEqual(new Set([floor]));
  });
});
