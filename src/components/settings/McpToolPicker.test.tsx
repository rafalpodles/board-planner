// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { McpToolPicker, parseAllowlist } from "./McpToolPicker";

afterEach(cleanup);

const CATALOG = [
  { name: "notion-search", description: "Search pages in the workspace", readSafe: true },
  { name: "notion-fetch", description: "Read one page", readSafe: true },
  { name: "notion-update-page", description: "Append blocks to a page", readSafe: false },
];

// `null`, not `undefined`: passing undefined would silently fall back to the default parameter
// and the "never tested" case below would quietly test the opposite of what it says.
function setup(allowlist = "", catalog: typeof CATALOG | null = CATALOG) {
  const onChange = vi.fn();
  render(
    <McpToolPicker
      rowName="notion"
      catalog={catalog ?? undefined}
      allowlist={allowlist}
      onChange={onChange}
    />
  );
  return onChange;
}

describe("McpToolPicker", () => {
  it("shows each tool's description, so the list can be chosen from without knowing it", () => {
    setup();

    expect(screen.getByText("Search pages in the workspace")).toBeTruthy();
    expect(screen.getByText("Append blocks to a page")).toBeTruthy();
  });

  it("marks the tools that write", () => {
    setup();

    const marks = screen.getAllByText("writes");
    expect(marks).toHaveLength(1);
  });

  it("ticking a tool adds its name to the stored comma-separated list", () => {
    const onChange = setup("notion-search");

    fireEvent.click(screen.getByLabelText("notion-fetch for notion"));

    expect(onChange).toHaveBeenCalledWith("notion-search, notion-fetch");
  });

  it("unticking removes it", () => {
    const onChange = setup("notion-search, notion-fetch");

    fireEvent.click(screen.getByLabelText("notion-search for notion"));

    expect(onChange).toHaveBeenCalledWith("notion-fetch");
  });

  it("reflects an allowlist written before this existed, without rewriting it", () => {
    setup("notion-fetch");

    expect((screen.getByLabelText("notion-fetch for notion") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("notion-search for notion") as HTMLInputElement).checked).toBe(false);
  });

  /**
   * An empty allowlist is every tool the server has, not none. Reading it as zero is the exact
   * misunderstanding that let 86 tools into every call on BP.
   */
  it("counts an empty allowlist as the whole catalogue, not as nothing", () => {
    setup("");

    expect(screen.getByText(/All 3 tools/)).toBeTruthy();
    expect(screen.getByText(/1,050 tokens per model call/)).toBeTruthy();
  });

  it("counts the ticked tools once there are any", () => {
    setup("notion-search");

    expect(screen.getByText(/1 of 3 selected/)).toBeTruthy();
    expect(screen.getByText(/350 tokens per model call/)).toBeTruthy();
  });

  // The control: without a catalogue the text field is the only way in, and it must still work.
  it("falls back to the text field when the server was never tested", () => {
    const onChange = setup("a, b", null);

    const field = screen.getByLabelText("Tool allowlist for notion") as HTMLInputElement;
    expect(field.value).toBe("a, b");
    fireEvent.change(field, { target: { value: "a, b, c" } });
    expect(onChange).toHaveBeenCalledWith("a, b, c");
    expect(screen.queryByText(/selected/)).toBeNull();
  });
});

describe("parseAllowlist", () => {
  it("ignores blanks and stray whitespace the field invites", () => {
    expect(parseAllowlist(" a ,, b , ")).toEqual(["a", "b"]);
    expect(parseAllowlist("")).toEqual([]);
  });
});
