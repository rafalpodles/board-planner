/**
 * Draws the seeded random sample of absence assertions that e2e/mutations/sample.json mutates (BP-1092).
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/mutation-check/sample.ts [--seed 1092] [--size 50]
 */
import fs from "node:fs";
import path from "node:path";
import { absenceAssertions, seededSample } from "./lib.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

const specs = fs
  .readdirSync(path.join(ROOT, "e2e"))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort()
  .map((name) => ({ spec: `e2e/${name}`, text: fs.readFileSync(path.join(ROOT, "e2e", name), "utf8") }));
const all = absenceAssertions(specs);
const sample = seededSample(all, option("--size", 50), option("--seed", 1092));
console.log(`${all.length} absence assertions; sample of ${sample.length}`);
for (const a of sample) console.log(`${a.spec}:${a.line}\t${a.test}\t${a.source}`);
