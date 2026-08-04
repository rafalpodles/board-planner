import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const css = readFileSync(join(SRC, "app/globals.css"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const files = sourceFiles(SRC);

describe("focus-ring utility", () => {
  it("is defined against :focus-visible, so a mouse click leaves no ring behind", () => {
    expect(css).toMatch(/\.focus-ring:focus-visible\s*\{/);
    expect(css).toMatch(/\.focus-ring-inset:focus-visible\s*\{/);
  });

  // Both themes retune --color-primary, so the outline follows without a second rule
  it("draws with the primary token rather than a colour literal", () => {
    const rule = css.slice(css.indexOf(".focus-ring:focus-visible"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("var(--color-primary)");
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

// Killing the browser's outline without drawing something in its place leaves a
// control that is focusable but invisible to anyone navigating by keyboard
describe("no control strips its outline without a replacement", () => {
  const REPLACEMENTS = [
    "focus-ring",
    "ring-",
    "focus:border-",
    "focus-visible:border-",
    "outline-2",
    "outline-primary",
  ];

  // The rule assumes a control whose focus is invisible without an outline. A text
  // input is the one case where that is false: it is marked by its own caret. Each
  // exemption is listed here with its reason, so adding one is a reviewable act
  // rather than a class quietly slipping past the regex.
  // `placeholder:` pins each exemption to the text field it was granted for, so an
  // outline stripped from a button in the same file still fails.
  const CARET_MARKS_FOCUS = [
    {
      file: "components/search/SearchLayer.tsx",
      onlyOn: "placeholder:",
      // focused from the moment the layer opens; a box around it for the whole
      // search reads as a validation error rather than as focus
    },
    {
      file: "components/ui/Combobox.tsx",
      onlyOn: "placeholder:",
      // same as above: the panel focuses it on open, so the ring would be on for the
      // whole life of the dropdown, framing a field nobody has typed in yet
    },
  ];

  const exempt = (path: string, line: string) =>
    CARET_MARKS_FOCUS.some((e) => path.endsWith(e.file) && line.includes(e.onlyOn));

  const offenders = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({ file, line, number: i + 1 }))
      .filter(({ line }) => /(focus(-visible)?:)?outline-none/.test(line))
      .filter(({ line }) => !REPLACEMENTS.some((token) => line.includes(token)))
      .filter(({ file: path, line }) => !exempt(path, line))
  );

  it("finds none", () => {
    expect(
      offenders.map((o) => `${o.file.replace(`${SRC}/`, "")}:${o.number}`)
    ).toEqual([]);
  });

  // An exemption that stops matching is an exemption nobody is checking any more
  it.each(CARET_MARKS_FOCUS)("$file still has the field its exemption was granted for", (e) => {
    const lines = readFileSync(join(SRC, e.file), "utf8").split("\n");
    const exempted = lines.filter(
      (line) => /outline-none/.test(line) && line.includes(e.onlyOn)
    );
    expect(exempted).toHaveLength(1);
  });
});

describe("the redesigned shell carries the convention", () => {
  const SHELL = [
    "components/shell/Sidebar.tsx",
    "components/shell/ProjectTree.tsx",
    "components/kanban/BoardHeader.tsx",
    "components/kanban/BoardFilters.tsx",
    "components/kanban/Column.tsx",
  ];

  it.each(SHELL)("%s applies a focus ring", (relative) => {
    expect(readFileSync(join(SRC, relative), "utf8")).toContain("focus-ring");
  });
});
