import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("focus treatment", () => {
  it("leaves no field with a :focus ring or a suppressed outline", () => {
    // `focus:ring-*` is a box-shadow keyed on :focus, so it fires on a mouse click and is
    // painted outside the border box, where a scroll container clips it — BP-340 shipped
    // fields whose ring was drawn along the top and bottom only. `focus:outline-none` on its
    // own leaves a field with no indicator at all. Fields use `.focus-ring` (globals.css)
    // instead. `focus-visible:ring-*` stays allowed: the task card composes a box-shadow ring
    // with the outline that carries its run state, which an outline would replace rather
    // than sit beside.
    const offenders = walk(SRC)
      .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n") }))
      .flatMap(({ file, lines }) =>
        lines
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => /\bfocus:ring-|\bfocus:outline-none/.test(line))
          .map(({ n, line }) => `${file.replace(SRC, "src")}:${n} ${line.trim().slice(0, 90)}`)
      );

    expect(offenders).toEqual([]);
  });

  it("gives every shared field the shell's focus treatment", () => {
    for (const name of ["Input.tsx", "Textarea.tsx", "Select.tsx"]) {
      const source = readFileSync(join(SRC, "components/ui", name), "utf8");
      expect(source, `${name} should carry focus-ring`).toContain("focus-ring");
    }
  });

  it("keeps the modal body clear of the scrollport edge", () => {
    // The body scrolls, and a scrollport clips what its descendants paint outside it —
    // an outline exactly as much as a box-shadow. Without this the focus ring of every
    // full-width field in every modal loses its left and right strokes.
    const modal = readFileSync(join(SRC, "components/ui/Modal.tsx"), "utf8");
    const body = modal.split("\n").find((l) => l.includes("overflow-y-auto"));
    expect(body).toBeDefined();
    expect(body).toContain("scroll-ring-room");
  });
});
